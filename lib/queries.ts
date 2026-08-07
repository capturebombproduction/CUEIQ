import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type {
  EventRow,
  Group,
  MicAssignment,
  Member,
  Role,
  ScheduleItem,
  SetlistItem,
  Song,
  Tenant,
} from "@/lib/types";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";

export interface Workspace {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  groups: Group[];
  /** The user's per-band roles (group_roles rows the user owns). */
  groupRoles: GroupRoleRow[];
  /** Effective permissions for the UI (mirror of the DB's RLS helpers). */
  perms: Perms;
}

/**
 * Resolve the signed-in user's tenant, role and groups (MVP: one tenant).
 * Wrapped in React.cache so the (app) layout AND the page can both call it within
 * one request and it only runs once (dedupes the getUser + workspace queries per
 * navigation — request-scoped, NOT cross-request, so no staleness).
 */
export const getWorkspace = cache(async (): Promise<Workspace> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      user: null,
      membership: null,
      tenant: null,
      groups: [],
      groupRoles: [],
      perms: makePerms(null),
    };
  }

  const name =
    (user.user_metadata?.full_name as string | undefined) ??
    user.email ??
    null;
  const base = { id: user.id, email: user.email ?? null, name };

  // Both of these key on user.id alone, so they go out together. This runs on
  // EVERY authenticated navigation (the layout awaits it before rendering
  // anything), and each Supabase round trip from the serverless region is worth
  // real milliseconds — the group_roles read used to sit behind the membership
  // read for no reason but the order it was written in.
  const [{ data: memberRow }, { data: groupRoleRows }] = await Promise.all([
    supabase
      .from("tenant_members")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("group_roles").select("group_id, role").eq("user_id", user.id),
  ]);

  if (!memberRow) {
    return {
      user: base,
      membership: null,
      tenant: null,
      groups: [],
      groupRoles: [],
      perms: makePerms(null),
    };
  }

  const role = memberRow.role as Role;

  const [{ data: tenant }, { data: groups }] = await Promise.all([
    supabase
      .from("tenants")
      .select("*")
      .eq("id", memberRow.tenant_id)
      .maybeSingle(),
    supabase
      .from("groups")
      .select("*")
      .eq("tenant_id", memberRow.tenant_id)
      .order("created_at", { ascending: true }),
  ]);

  const groupRoles = (groupRoleRows ?? []) as GroupRoleRow[];

  return {
    user: base,
    membership: {
      tenant_id: memberRow.tenant_id as string,
      role,
    },
    tenant: (tenant as Tenant) ?? null,
    groups: (groups ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
});

export interface EventBundle {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
  lineup: string[]; // member_ids performing at this event (empty = not chosen yet)
}

/** Thai names for the seven reads that make up an event bundle, so the failure a
 * user sees says WHICH part could not be read instead of a bare stack trace. */
const BUNDLE_PART_LABELS: Record<string, string> = {
  event: "ข้อมูลงาน",
  schedule: "รันดาวน์",
  setlist: "เซ็ตลิสต์",
  micMap: "ผังไมค์",
  members: "สมาชิกวง",
  songs: "คลังเพลง",
  lineup: "ผู้เล่นงานนี้",
};

/** The only shape of a PostgREST response this module needs in order to judge it. */
type ReadOutcome = { error: { message?: string | null } | null };

/**
 * "Did every read of this bundle actually happen?" — returns an Error to throw, or
 * null when all of them succeeded.
 *
 * WHY THIS EXISTS (round 10). getEventBundle used to write `schedule.data ?? []`
 * for all six child reads and never look at `.error`. postgrest-js does NOT throw:
 * a 500, a 429, a statement timeout or a dead pooler all resolve as
 * `{ data: null, error }`, and `?? []` then turns a FAILED READ into a genuine
 * empty list. The event page rendered a real show as having no setlist, no lineup
 * and no mic map, with nothing on screen saying anything had gone wrong.
 *
 * That is not merely cosmetic. setlist-builder's กู้คืน (restore a saved version)
 * takes `const old = items` from these props and deletes the current rows only
 * `if (old.length)`. Staff who open the event during a hiccup, see an empty
 * setlist, panic and restore a version get the snapshot INSERTED while the delete
 * half is skipped — the event ends up holding the original setlist PLUS a full
 * duplicate copy, and that is what the printed run sheet and Live Mode then use.
 * There is no unique constraint on (event_id, sort_order) to stop it.
 *
 * The desktop mirror of this same query has guarded this since it was written
 * (desktop/src/data/event-bundle.ts: "an errored child read must never be coerced
 * to an empty list") — it falls back to the last good cached bundle WHEN ONE
 * EXISTS. Do not read more into that sentence than it says: on a machine that has
 * never opened tonight's show the desktop's readCache misses and loadEventBundle
 * hands back null, which event.tsx still renders as "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง"
 * — the same wrong fact this guard exists to stop, on the copy that travels to
 * venues. That gap is real and is written up in the round-11 report; it is not
 * fixed here because desktop/ belongs to another surface.
 *
 * The web has no cache to fall back to, so the only honest answer here is to fail
 * loudly. Note WHERE the recovery lives: Next redacts a Server-Component throw in
 * production, so the client boundary never sees the Thai text below — it sees a
 * fixed English sentence plus a digest. app/(app)/error.tsx detects that redaction
 * and prints its own Thai copy + the digest, and logBundleFailure puts the real
 * cause in the server log under the same digest. The Thai copy here is therefore
 * for the SERVER LOG and for `next dev`; do not "improve" it expecting a user to
 * read it. An empty list must mean "this show really has no setlist yet".
 *
 * Pure and exported so lib/queries.test.ts can pin the behaviour without a DB.
 */
export function eventBundleReadFailure(
  eventId: string,
  reads: Record<string, ReadOutcome>
): Error | null {
  const failed = Object.entries(reads).filter(([, r]) => !!r?.error);
  if (failed.length === 0) return null;

  const labels = failed.map(([key]) => BUNDLE_PART_LABELS[key] ?? key).join(", ");
  const detail = failed
    .map(([key, r]) => `${key}: ${r.error?.message || "unknown error"}`)
    .join(" | ");
  const err = new Error(
    `อ่านข้อมูลงานไม่สำเร็จ (${labels}) — ลองใหม่อีกครั้ง ข้อมูลยังอยู่ครบ ` +
      `[event ${eventId} · ${detail}]`
  );
  // Named so a future caller can branch on it (`err.name === "EventBundleReadError"`)
  // instead of string-matching the Thai copy above.
  err.name = "EventBundleReadError";
  return err;
}

/** Is this string even shaped like an event id? (`events.id` is `uuid`.)
 *
 * WHY (round 11). The fail-loud guard below turns any populated `.error` on the
 * event read into a throw. But PostgREST answers `?id=eq.garbage` with HTTP 400
 * `22P02 invalid input syntax for type uuid` — a populated `.error` that means
 * "that is not an id", i.e. a NOT-FOUND, not a failed read. So the first shipping
 * of the guard replaced the Thai 404 with the red "หน้านี้มีปัญหา" crash card for
 * every truncated link pasted into LINE (`/events/9f3a1c8e-…-1f2a3b4c5d`), every
 * `/events/undefined` bookmark and every authenticated crawler — exactly the
 * traffic app/(app)/not-found.tsx was built for, plus a console.error per hit.
 *
 * Checking the shape here rather than the returned error code is deliberate: it
 * is deterministic (a pooler that answers a malformed query with a 500 instead of
 * a 400 still 404s, not crashes) and it saves a pointless round trip. It is
 * strict-canonical on purpose — every id in this product comes from
 * `gen_random_uuid()` and is only ever passed around as the canonical lowercase
 * hyphenated form, so nothing legitimate is rejected. */
export function isEventIdShaped(eventId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    eventId
  );
}

/** Load JUST the event row (+ its band), with the same "a failed read is not a
 * missing show" guard as the full bundle.
 *
 * WHY THIS IS SEPARATE (round 11). The all-or-none rule below is right for the
 * surfaces that reason about a show as a whole, and wrong for the ones that do
 * not. app/(app)/events/[id]/edit reads `bundle.event` and nothing else — no
 * setlist, no songs, no mic map — yet a statement timeout on the band's whole-
 * library `songs` select was blocking it. On show day that meant an Ar could not
 * push show_start_time back 20 minutes on a page whose every field had read fine.
 * A page that never receives a child list cannot be corrupted by a missing one.
 *
 * Returns null when the read succeeded and there is no such event; throws when
 * the read itself failed. */
export const getEventRow = cache(async (
  eventId: string
): Promise<EventBundle["event"] | null> => {
  if (!isEventIdShaped(eventId)) return null;

  const supabase = await createClient();

  const eventRead = await supabase
    .from("events")
    .select("*, groups(*)")
    .eq("id", eventId)
    .maybeSingle();

  // Separate the two reasons `data` can be null. maybeSingle() reports zero rows
  // as `{ data: null, error: null }`, so an error here always means the request
  // itself failed — never that the event is gone. Before this guard, a 500 on this
  // one read rendered "ไม่พบงานนี้" to a staff member standing in front of the
  // band whose show it is.
  const eventFailure = eventBundleReadFailure(eventId, { event: eventRead });
  if (eventFailure) throw logBundleFailure(eventFailure, "getEventRow");

  const event = eventRead.data;
  if (!event) return null;

  return {
    ...(event as unknown as EventRow),
    group: (event.groups as unknown as Group) ?? null,
  };
});

/** Load a single event with all of its child data.
 *
 * Returns null ONLY when the read succeeded and there is no such event (or RLS +
 * the caller's band scope hide it) — callers turn that into notFound(). When a
 * read FAILS it throws instead, because "could not be read" and "does not exist"
 * are different facts and staff were being shown "ไม่พบงานนี้" for shows that were
 * perfectly fine. cache()-wrapped so repeated calls within one request are deduped
 * (a thrown failure is memoised too, so the page fails once, not seven times). */
export const getEventBundle = cache(async (
  eventId: string
): Promise<EventBundle | null> => {
  const event = await getEventRow(eventId);
  if (!event) return null;

  const supabase = await createClient();

  const [schedule, setlist, micMap, members, songs, lineup] = await Promise.all([
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

  // All six or none. A bundle is presented to the UI as the complete truth about a
  // show — the completeness gate, the run sheet, Live Mode and the setlist restore
  // all reason about it as a whole — so handing back five good lists and one
  // silently-emptied one is worse than handing back nothing. See
  // eventBundleReadFailure above for the incident this prevents. A page that wants
  // only the event row must call getEventRow and stay out of this rule entirely,
  // rather than this rule being softened for everyone.
  const childFailure = eventBundleReadFailure(eventId, {
    schedule,
    setlist,
    micMap,
    members,
    songs,
    lineup,
  });
  if (childFailure) throw logBundleFailure(childFailure, "getEventBundle");

  return {
    event,
    // The `?? []` below are now only satisfying the types: past the guard above
    // every one of these reads succeeded, so a null `data` is not reachable. Do
    // NOT reintroduce one of these as a way to tolerate a failed read.
    schedule: (schedule.data ?? []) as ScheduleItem[],
    setlist: (setlist.data ?? []) as SetlistItem[],
    micMap: (micMap.data ?? []) as MicAssignment[],
    members: (members.data ?? []) as Member[],
    songs: (songs.data ?? []) as Song[],
    lineup: ((lineup.data ?? []) as { member_id: string }[]).map((r) => r.member_id),
  };
});

/** Put the real cause in the server log before throwing it.
 *
 * Next redacts a server-thrown message in production and shows the client only a
 * digest, so without this line the one place that knows WHY the show would not
 * open (the PostgREST message: timeout, 503, RLS recursion…) would be lost. The
 * (app) error boundary shows the digest, and this line is how that digest is
 * matched to a cause in the Vercel log.
 *
 * `where` is REQUIRED, and deliberately has no default. Round 11 split getEventRow
 * out of getEventBundle and left this string hard-coded, so a digest sent in from
 * /events/<id>/edit — a page that provably never calls getEventBundle — printed
 * "[CueIQ] getEventBundle read failed" and sent the next reader hunting through the
 * six child reads and the all-or-none guard for a failure that had happened in a
 * single-row lookup on a different code path. A default would have let the next
 * caller inherit the same wrong label silently; making it required means the
 * compiler asks. */
function logBundleFailure(err: Error, where: string): Error {
  console.error(`[CueIQ] ${where} read failed:`, err.message);
  return err;
}

/** Members in the tenant, grouped-ordered. Pass `groupIds` to scope to a subset
 * of bands (band-tier users see only their own; omit for the whole tenant). */
export async function getMembers(
  tenantId: string,
  groupIds?: string[]
): Promise<Member[]> {
  const supabase = await createClient();
  const base = supabase.from("members").select("*").eq("tenant_id", tenantId);
  const scoped = groupIds ? base.in("group_id", groupIds) : base;
  const { data } = await scoped
    .order("group_id", { ascending: true })
    .order("sort_order", { ascending: true });
  return (data ?? []) as Member[];
}

/** Songs in the tenant's library (newest first). Pass `groupIds` to scope to a
 * subset of bands (band-tier users see only their own; omit for the whole
 * tenant). An empty array returns nothing — correct for a user with no bands. */
export async function getSongs(
  tenantId: string,
  groupIds?: string[]
): Promise<Song[]> {
  const supabase = await createClient();
  const base = supabase.from("songs").select("*").eq("tenant_id", tenantId);
  const scoped = groupIds ? base.in("group_id", groupIds) : base;
  const { data } = await scoped.order("created_at", { ascending: false });
  return (data ?? []) as Song[];
}
