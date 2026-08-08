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

/** How long the SINGLE event read may wait on Supabase before the cache is served.
 *
 *  isOffline() only catches the network the OS knows is gone. The venue case that
 *  actually happens is the other one: wifi JOINED, navigator.onLine TRUE, TCP
 *  connects and nothing ever answers. None of the awaits below had a bound of their
 *  own, so the show screen sat on its spinner for ever with THIS EVENT'S OWN BUNDLE
 *  — the run sheet, the setlist, the mic map — already on disk, written for exactly
 *  this moment. Worse, warmEventBundle() is awaited once per event by the dashboard's
 *  "เตรียมทุกงาน" loop, so a single unreachable event stalled the entire bulk prepare
 *  that exists to make the device ready BEFORE the wifi is cut.
 *
 *  Matches WORKSPACE_READ_TIMEOUT_MS / EVENTS_LIST_TIMEOUT_MS: a working-but-slow
 *  hotspot should still get to deliver FRESH data rather than be written off as
 *  dead. Every timeout below takes the SAME branch the module already had for a
 *  failed read — the cached bundle — so this adds a bound, not a new state. */
export const EVENT_BUNDLE_TIMEOUT_MS = 8000;

/** How long the CHILD BATCH may wait — the one await here that is not one read.
 *
 *  This constant exists because the sentence above used to be a lie with a price on
 *  it. The batch is a Promise.all of SEVEN selects, two of them a whole band's
 *  members and songs, and a Promise.all settles when its SLOWEST leg does — so the
 *  single-read budget was 8s for all seven TOGETHER. Load-in, twenty phones on the
 *  venue hotspot, an Ar opening a show this laptop has never opened: the seven reads
 *  land in 9s, the network WORKS, it is merely congested. The bound fired, there was
 *  no cached bundle to fall back to, and the operator was told the show did not
 *  exist. A congested-but-working hotspot must still be allowed to deliver the show.
 *
 *  So the batch gets its own, larger budget rather than the comment being softened
 *  to match the number: 2.5x the single-read budget for 7x the reads. Still bounded,
 *  and a timeout still takes the module's existing failed-read branch (the cache).
 *
 *  Worst case for one loadEventBundleStatus() on a network that answers the first
 *  read and then goes black: 8s + 20s = 28s. It used to be three stacked bounds
 *  (8 + 8 + 8) because the membership read was awaited on its own; it now rides in
 *  the same batch, which is both one fewer bound to stack and one fewer round trip
 *  on the good path. On a network that is dead from the start it is still 8s. */
export const EVENT_BUNDLE_BATCH_TIMEOUT_MS = 20000;

/** How long the "was that empty answer really empty?" session probe may wait.
 *
 *  Deliberately much shorter than a read budget. It is a SECONDARY probe — it only
 *  runs after a read has already answered — and getSession() is a storage read plus,
 *  at worst, one refresh POST, so 2s is generous when anything is working at all.
 *  It is also the one bound here whose expiry costs nothing: a timeout takes the
 *  same "keep the cached bundle" branch that a slow answer would have produced. */
export const EVENT_BUNDLE_SESSION_TIMEOUT_MS = 2000;

/** Resolves to `null` if `p` has not settled within `ms`. The in-flight request is
 *  not cancelled, it is ABANDONED: the timer is cleared on both outcomes, nothing
 *  subscribes to `p` after the race settles so a late value is discarded (it does
 *  NOT warm any cache — no path here writes one), and a late rejection is still
 *  observed by the race, so it cannot go unhandled. (Mirrors ~/data/workspace.ts,
 *  which owns the canonical comment; kept local because that copy is not exported.) */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    // Without this the pending timer keeps a handle alive for its full duration
    // after every fast, successful load.
    if (timer !== undefined) clearTimeout(timer);
  });
}

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

/** What one load actually learned.
 *
 *  `unreachable` is the difference between two answers that used to be one: "the
 *  server told us this show is gone, or is not yours" and "we never got a
 *  trustworthy answer at all" (offline, a read that timed out, rejected or came
 *  back errored, or a session we could not prove). Both resolved to a bare `null`,
 *  so pages/event.tsx rendered the same dead end — "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง"
 *  and one button back to the dashboard — for a show that was merely behind a
 *  congested hotspot, with no way to try again.
 *
 *  `bundle` can be non-null WITH `unreachable` true: the cache covered it, and the
 *  caller has something to render either way. Only a null bundle needs the flag. */
export interface EventBundleLoad {
  bundle: EventBundle | null;
  unreachable: boolean;
}

export async function loadEventBundleStatus(eventId: string): Promise<EventBundleLoad> {
  const supabase = createClient();
  const cacheKey = bundleKey(eventId);

  /** Every failure below lands here: a failed read is not a missing show. Offline
   *  counts — we did not reach the server, so a miss here is "no copy on this
   *  device", never "no such show". */
  const servedFromCache = async (): Promise<EventBundleLoad> => ({
    bundle: await withPendingOverlay(readCache<EventBundle>(cacheKey), eventId),
    unreachable: true,
  });

  // Offline: the network reads below would all fail, so serve the last good
  // bundle for this event from cache (null if it was never opened online).
  if (isOffline()) return servedFromCache();

  let eventRes;
  try {
    // A request that NEVER answers is the same situation as one that fails, so it
    // takes the same branch: withTimeout hands back null and we serve the cache.
    eventRes = await withTimeout(
      supabase.from("events").select("*, groups(*)").eq("id", eventId).maybeSingle(),
      EVENT_BUNDLE_TIMEOUT_MS
    );
  } catch {
    // Network failure mid-read → fall back to the cached bundle.
    return servedFromCache();
  }
  if (!eventRes) return servedFromCache();

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
    // getSession() can itself attempt a token refresh over the same dead network,
    // so bound it too: a timeout means "we could NOT prove the session is live",
    // which is precisely the case this guard already refuses to call a deletion.
    const proven = await withTimeout(hasLiveSession(), EVENT_BUNDLE_SESSION_TIMEOUT_MS);
    const reallyGone = !eventRes.error && proven === true;
    if (!reallyGone) return servedFromCache();
    // Proven gone. The overlay may still synthesize a pending offline create.
    return { bundle: await withPendingOverlay(null, eventId), unreachable: false };
  }

  // This used to be TWO awaits, both OUTSIDE any try/catch, so a REJECTION escaped
  // loadEventBundle entirely instead of falling through to the cache the caller
  // needs — and neither had a bound, so a black-holed venue wifi parked the show
  // screen here for ever. One try/catch and one bound, feeding the module's
  // existing branches. The membership read joins the batch rather than being
  // awaited ahead of it: it depends on nothing the children produce, so waiting for
  // it first only bought a second stacked timeout and a second round trip.
  let batch;
  try {
    batch = await withTimeout(
      Promise.all([
        supabase
          .from("tenant_members")
          .select("role")
          .eq("tenant_id", event.tenant_id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
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
      ]),
      EVENT_BUNDLE_BATCH_TIMEOUT_MS
    );
  } catch {
    return servedFromCache();
  }
  // A read that never answered is a read that failed — never an empty child list.
  if (!batch) return servedFromCache();

  const [membershipRes, schedule, setlist, micMap, members, songs, lineup] = batch;

  // postgrest resolves a network failure as { data: null, error } — it does NOT
  // throw — so an errored child read must never be coerced to an empty list:
  // caching that would overwrite the last GOOD offline bundle with an empty
  // setlist/schedule/mic map. Cache only a COMPLETE read (like workspace.ts);
  // on any failed read fall back to the cached copy, same as the catch above.
  if (batch.some((r) => r.error)) {
    return servedFromCache();
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
  return { bundle: await withPendingOverlay(bundle, eventId), unreachable: false };
}

/** The bundle alone — for every caller with nothing different to do about a show it
 *  could not reach than about a show that is gone. pages/event.tsx is the one that
 *  does care, and calls loadEventBundleStatus directly. */
export async function loadEventBundle(eventId: string): Promise<EventBundle | null> {
  return (await loadEventBundleStatus(eventId)).bundle;
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
 * Never throws, and never HANGS: the dashboard's "เตรียมทุกงาน" awaits this once per
 * event in sequence, so one unreachable show must neither abort the rest of a prepare
 * run nor stall it — every await in loadEventBundle is bounded (EVENT_BUNDLE_TIMEOUT_MS
 * for the event read, EVENT_BUNDLE_BATCH_TIMEOUT_MS for the child batch), so the
 * longest one show can hold the loop is the sum of the two.
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
