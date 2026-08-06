// Client-side mirror of lib/queries.ts `getEventBundle` for the desktop SPA.
// Loads one event with all of its child data through the browser Supabase client.
// Every return path applies the pending offline-management ops (⭐#1 step 2): an
// offline metadata edit patches the bundle, and an event CREATED offline gets a
// synthesized bundle so it opens like any other event (empty children; members +
// songs borrowed from a cached sibling bundle of the same band when available).
import { createClient } from "@/lib/supabase/client";
import { applyPendingChildren, materializeEventRow } from "@/lib/mgmt-outbox";
import { hasCache, isOffline, readCache, readCacheKeys, writeCache } from "~/data/cache";
import { hasLiveSession } from "@/lib/auth-session";
import { listMgmtConflicts, pendingMgmtOps } from "~/data/mgmt-outbox";
import type { WorkspaceData } from "~/data/workspace";
import type {
  EventRow,
  Group,
  MicAssignment,
  Member,
  Role,
  ScheduleItem,
  SetlistItem,
  Song,
} from "@/lib/types";

export interface EventBundle {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
  lineup: string[]; // member_ids performing at this event (empty = not chosen yet)
  role: Role | null;
}

/** Read-cache key for one event's bundle — shared by the loader and the probes below. */
const bundleKey = (eventId: string) => `event:${eventId}`;

/** First cached bundle belonging to `groupId` — a source of members/songs offline. */
function findCachedSibling(groupId: string | undefined): EventBundle | null {
  if (!groupId) return null;
  for (const key of readCacheKeys("event:")) {
    const b = readCache<EventBundle>(key);
    if (b?.event.group_id === groupId) return b;
  }
  return null;
}

/** Overlay this event's pending offline ops onto the loaded (or missing) bundle. */
async function withPendingOverlay(
  bundle: EventBundle | null,
  eventId: string
): Promise<EventBundle | null> {
  const ops = (await pendingMgmtOps()).filter((op) => op.id === eventId);
  if (ops.length === 0) return bundle;
  if (ops.some((op) => op.kind === "event.delete")) return null;

  let out = bundle;
  const create = ops.find((op) => op.kind === "event.create");
  if (!out && create && create.kind === "event.create") {
    // Created offline, not on the server yet: synthesize an openable bundle.
    const ws = readCache<WorkspaceData>("workspace");
    const group = ws?.groups.find((g) => g.id === create.values.group_id) ?? null;
    const sibling = findCachedSibling(create.values.group_id);
    out = {
      event: { ...materializeEventRow(create, new Date().toISOString()), group },
      schedule: [],
      setlist: [],
      micMap: [],
      members: sibling?.members ?? [],
      songs: sibling?.songs ?? [],
      lineup: [],
      role: ws?.membership?.role ?? null,
    };
  }
  if (!out) return null;
  for (const op of ops) {
    if (op.kind === "event.update") out = { ...out, event: { ...out.event, ...op.patch } };
  }
  // Child-list snapshots (⭐#1 step 5): a queued offline setlist/schedule/mic/
  // lineup edit replaces its whole list, so reopening the event shows it.
  return applyPendingChildren(out, ops, eventId);
}

export async function loadEventBundle(eventId: string): Promise<EventBundle | null> {
  const supabase = createClient();
  const cacheKey = bundleKey(eventId);

  // Offline: the network reads below would all fail, so serve the last good
  // bundle for this event from cache (null if it was never opened online).
  if (isOffline()) return withPendingOverlay(readCache<EventBundle>(cacheKey), eventId);

  let eventRes;
  try {
    eventRes = await supabase
      .from("events")
      .select("*, groups(*)")
      .eq("id", eventId)
      .maybeSingle();
  } catch {
    // Network failure mid-read → fall back to the cached bundle.
    return withPendingOverlay(readCache<EventBundle>(cacheKey), eventId);
  }

  const event = eventRes.data;
  if (!event) {
    // Tell a real "deleted" (read succeeded, row gone) apart from an error: only
    // resurface the cache on an actual error, never for a genuine deletion.
    // (The overlay still synthesizes a pending offline CREATE the flusher hasn't
    // landed yet — to the server that id doesn't exist, but it must open here.)
    // A request sent as anon is a third case that looks like the second: RLS
    // answers it with an empty row and no error, so an event whose bundle is
    // sitting right here on disk would open as "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง"
    // just because a token refresh failed a moment ago (see hasLiveSession).
    const reallyGone = !eventRes.error && (await hasLiveSession());
    return withPendingOverlay(reallyGone ? null : readCache<EventBundle>(cacheKey), eventId);
  }

  const membershipRes = await supabase
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", event.tenant_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const childResults = await Promise.all([
    supabase
      .from("schedule_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("mic_assignments")
      .select("*")
      .eq("event_id", eventId)
      .order("mic_number", { ascending: true })
      .order("order_index", { ascending: true }),
    supabase
      .from("members")
      .select("*")
      .eq("group_id", event.group_id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("songs")
      .select("*")
      .eq("group_id", event.group_id)
      .order("title", { ascending: true }),
    supabase
      .from("event_members")
      .select("member_id")
      .eq("event_id", eventId),
  ]);
  const [schedule, setlist, micMap, members, songs, lineup] = childResults;

  // postgrest resolves a network failure as { data: null, error } — it does NOT
  // throw — so an errored child read must never be coerced to an empty list:
  // caching that would overwrite the last GOOD offline bundle with an empty
  // setlist/schedule/mic map. Cache only a COMPLETE read (like workspace.ts);
  // on any failed read fall back to the cached copy, same as the catch above.
  if (membershipRes.error || childResults.some((r) => r.error)) {
    return withPendingOverlay(readCache<EventBundle>(cacheKey), eventId);
  }

  const bundle: EventBundle = {
    event: {
      ...(event as unknown as EventRow),
      group: (event.groups as unknown as Group) ?? null,
    },
    schedule: (schedule.data ?? []) as ScheduleItem[],
    setlist: (setlist.data ?? []) as SetlistItem[],
    micMap: (micMap.data ?? []) as MicAssignment[],
    members: (members.data ?? []) as Member[],
    songs: (songs.data ?? []) as Song[],
    lineup: ((lineup.data ?? []) as { member_id: string }[]).map((r) => r.member_id),
    role: (membershipRes.data?.role as Role) ?? null,
  };
  writeCache(cacheKey, bundle);
  // Cache the SERVER truth, then overlay pending local edits on top for display.
  return withPendingOverlay(bundle, eventId);
}

/** Does THIS device hold `eventId`'s bundle, i.e. can the show be OPENED with no net? */
export function isEventBundleCached(eventId: string): boolean {
  return hasCache(bundleKey(eventId));
}

/**
 * Does the offline management outbox still hold a pending op for this event?
 * Exists for lib/show-run-outbox.ts's eventIsGone(): a show run entirely offline
 * on an event created offline (saveEventWrite's queued `event.create`, see
 * lib/mgmt-outbox.ts newEventId) has no server row yet — a show-run write racing
 * ahead of that create must not read "no such row" as "the row was deleted" and
 * drop the night's run time. pendingMgmtOps() already resolves to [] on any
 * failure, so this never throws.
 */
export async function hasPendingEventOp(eventId: string): Promise<boolean> {
  if ((await pendingMgmtOps()).some((op) => op.id === eventId)) return true;
  // PARKED counts too. A create that could not be replayed is moved out of the
  // ops store and into conflicts, and a conflict means "waiting for a human to
  // look at it" — never "deleted". Reading only the ops store would let the show
  // run time queued against that event be dropped the moment its create parked,
  // which is the opposite of what parking is for.
  return (await listMgmtConflicts()).some(({ rec }) => rec.op.id === eventId);
}

/**
 * Pull one event's bundle down and leave it in the read-cache. Offline readiness is
 * DATA + BYTES: a device with every audio file but no cached bundle still opens the
 * show as "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง" at the venue — the audio on disk is
 * unreachable — so the dashboard's bulk prepare warms this alongside the files.
 * Never throws: one unreachable event must not abort the rest of a prepare run.
 */
export async function warmEventBundle(eventId: string): Promise<boolean> {
  try {
    await loadEventBundle(eventId);
  } catch {
    /* best-effort, same contract as the read-cache itself */
  }
  return isEventBundleCached(eventId);
}

// Bridge to SHARED code: components/event/events-list.tsx (the dashboard) and
// lib/show-run-outbox.ts (eventIsGone). Both are compiled into the WEB build too,
// where the "~" alias doesn't resolve, so neither can import this module — hand
// them the functions on `window` instead. This file is statically imported by the
// desktop App, so the bridge exists before any route renders; nothing publishes it
// in a browser, where callers read `undefined` and keep their byte-only behaviour.
if (typeof window !== "undefined") {
  (window as unknown as { cueiqEventCache?: unknown }).cueiqEventCache = {
    isCached: isEventBundleCached,
    warm: warmEventBundle,
    hasPendingOp: hasPendingEventOp,
  };
}
