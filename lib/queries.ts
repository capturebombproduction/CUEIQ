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
import { assertReadsSucceeded, readFailure } from "@/lib/read-guard";

export interface Workspace {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  /** Every band in the tenant.
   *
   *  ⚠️ THE ONE FIELD HERE THAT CAN THROW WHEN YOU READ IT. If the `groups` select
   *  failed, getWorkspace() still resolves (so routes that never touch this field —
   *  the (app) layout, /events/[id], /events/[id]/run-order/live — keep working) and
   *  this property raises the read failure instead of handing you `[]`. `[]` is fed
   *  back into the events query as `.in("group_id", …)`, so a discarded failure
   *  shows a band an empty day and passes its own honesty check. See READ 4 in
   *  getWorkspace. Nothing to check and nothing to opt into: read it and you are
   *  guarded, don't and you are unaffected. */
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
 *
 * A FAILED READ IS NOT A PERMISSION ANSWER (round 12).
 *
 * lib/read-guard.ts was wired into four server pages so that a failed read stops
 * becoming a confident wrong number. This function runs FIRST on all four of them
 * — the (app) layout awaits it before anything renders — and it used to discard
 * `.error` on all four of ITS OWN reads. So "every read on this page is honest"
 * was false at the top of every page that claimed it, and these four failures are
 * SHARPER than the counts that were fixed, because they come out as a permission
 * answer rather than as a number. A wrong count at least looks like data the user
 * can question; "บัญชียังไม่ได้รับสิทธิ์เข้าวง" looks like a settled fact about
 * their account, and there is nothing on screen to retry.
 *
 * So: no read here may be discarded, each for the reason written at its guard
 * below, and none of them changes what an EMPTY-but-successful read does. Reads
 * 1-3 throw ON SIGHT; read 4 (`groups`) throws ON ACCESS instead, for the reason
 * argued at its guard. Two notes on the verdict, because "throw on everything" is
 * the lazy version of it:
 *
 *  • It is what the desktop mirror already decided. desktop/src/data/workspace.ts
 *    folds tenants, groups AND group_roles into one `blipped` flag, refuses to
 *    believe the half-empty result and refuses to cache it. It can then fall back
 *    to the last good workspace; a SERVER render has no such fallback, so the web's
 *    only way to say "do not believe this" is to throw. Same invariant, and the
 *    same asymmetry lib/read-guard.ts already documents.
 *  • WHERE an ON-SIGHT throw lands is not the (app) card, and pretending otherwise
 *    would send the next reader to the wrong file. Next's error.tsx does not catch
 *    a throw from the layout in its own SEGMENT — verified in the shipped runtime,
 *    where create-component-tree passes the segment's error module as the `error`
 *    prop of the LayoutRouter that becomes that segment's CHILDREN — and the (app)
 *    layout is the first caller (React.cache memoises the rejection, so all 14
 *    pages inherit it without running). So it sails past app/(app)/error.tsx to
 *    **app/error.tsx**, which exists for exactly this and renders the same
 *    components/error-card.tsx inside the real root layout, digest and all.
 *    app/global-error.tsx is now reached only by a throw in the ROOT layout itself.
 *    assertReadsSucceeded logs the real cause under "[CueIQ] getWorkspace read
 *    failed", which is what to grep in the Vercel log.
 *    ⚠️ Deleting or moving app/error.tsx silently sends this back to global-error
 *    with every gate green — app/error-boundary.test.tsx is the tripwire.
 *    An ON-ACCESS throw (read 4) is raised by the PAGE, not the layout, so it lands
 *    one boundary lower — app/(app)/error.tsx, same card, nav still on screen. It
 *    carries the same name and the same Thai text; only the boundary differs.
 *
 * NOT covered here, deliberately: `supabase.auth.getUser()` below still discards
 * its error. For the two ordinary causes — no cookie, and a refresh token the
 * server rejects — `user: null` → redirect("/login") is the RIGHT answer, and
 * turning those into an error card would strand a user whose only way out is to
 * sign in again. A transport failure on that call therefore still reads as
 * "signed out". Fixing that needs auth-error classification, which is machinery,
 * not a guard; it is a known gap, not an oversight.
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
  const [memberRead, groupRoleRead] = await Promise.all([
    supabase
      .from("tenant_members")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("group_roles").select("group_id, role").eq("user_id", user.id),
  ]);

  // READ 1 — tenant_members. FATAL: this row IS the answer to "who is this user in
  // the label", so a failure means we cannot answer it at all. Discarded, its
  // `.error` became `membership: null`, and `membership: null` means exactly one
  // thing to every caller: this account belongs to no band. /overview and
  // /dashboard render <JoinDemo/> ("บัญชียังไม่ได้รับสิทธิ์เข้าวง"), and BOTH
  // /events/[id]/run-order routes silently redirect("/dashboard") — the route about
  // nineteen phones open within seconds of each other when staff press เริ่ม. One
  // statement timeout at a festival and a real label member is told, with no error
  // and nothing to retry, that they are not a member.
  assertReadsSucceeded("getWorkspace", { "สังกัดของผู้ใช้": memberRead });

  const memberRow = memberRead.data;

  if (!memberRow) {
    // EMPTY BUT SUCCESSFUL — unchanged, and it must stay that way. maybeSingle()
    // reports "no such row" as `{ data: null, error: null }`, so past the guard
    // above this really is a brand-new account with no membership, and the join
    // screen is the correct page for it.
    //
    // group_roles is deliberately NOT judged on this path — the one degrade in this
    // function, and it is a degrade only in the sense that we decline to fail over a
    // read whose answer we are about to throw away: with no tenant membership the
    // return below is `groupRoles: []` + `makePerms(null)` no matter what that read
    // said, and no permission anywhere is derived from it. Judging it would turn a
    // first-login hiccup into an error card on the one screen whose whole job is to
    // say "ask an admin to add you".
    return {
      user: base,
      membership: null,
      tenant: null,
      groups: [],
      groupRoles: [],
      perms: makePerms(null),
    };
  }

  // READ 2 — group_roles. FATAL from here on, because from here on the answer is
  // USED, and an empty one is the sharpest of the four: canViewGroup() falls back to
  // it for every band-tier user, so a timeout locks an Ar out of their own band's
  // show, empties /overview through viewableGroups(), sends a band member who is not
  // label-wide out of /overview entirely (canViewOverview → groupRoles.length), and
  // removes the "New Event" button (canCreateAnyEvent → groupRoles.some(…)).
  //
  // No role-shaped exception, though the temptation is obvious: isLabelWideUser()
  // short-circuits canViewGroup, so an admin looks unaffected. They are not —
  // canCreateAnyEvent() and editableGroups() read group_roles for a ceo too, and the
  // branch would have to be evaluated after the fact anyway, since both reads go out
  // in parallel before the role is known. One rule for everyone.
  assertReadsSucceeded("getWorkspace", { "บทบาทในวง": groupRoleRead });

  const role = memberRow.role as Role;

  const [tenantRead, groupsRead] = await Promise.all([
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

  // READ 3 — tenants. FATAL ON SIGHT: four callers gate on `!ws.tenant` in the same
  // breath as `!ws.membership` (`if (!ws.membership || !ws.tenant)`), so a null
  // tenant IS the "not in a band" answer, with the same JoinDemo and the same silent
  // redirect("/dashboard") as read 1 — reached this time through a row we know
  // exists, because the membership we just read points at it. Every route that gets
  // past this line needs `tenant`, including the show-caller, so there is nothing to
  // defer: throwing here and throwing at the first access are the same event.
  //
  // Read 4 is named alongside it when BOTH failed, which one pooler outage does:
  // these two go out in the same Promise.all, and a log line that names only half of
  // a double failure sends the next reader hunting for a tenants-specific cause.
  if (tenantRead.error) {
    assertReadsSucceeded("getWorkspace", {
      "ข้อมูลค่าย": tenantRead,
      "รายชื่อวง": groupsRead,
    });
  }

  // READ 4 — groups. NOT fatal on sight, and NOT tolerated either: `ws.groups` comes
  // back POISONED. Reading the property throws the identical ReadFailedError read 3
  // would have thrown; not reading it costs nothing.
  //
  // WHY IT MAY NOT BE DISCARDED (unchanged, and the reason this is not simply
  // demoted to a warning). An errored list becomes `[]`, i.e. "this label has no
  // bands" — and it does not stop there, because `[]` is then fed BACK IN as a query
  // filter: /dashboard and /overview both scope their events read with
  // `.in("group_id", viewableGroupIds)`, so an empty groups list makes the event read
  // return zero rows while SUCCEEDING, and each page's own assertReadsSucceeded then
  // confirms that everything read fine. A band is shown an empty day by a board that
  // has just verified its own honesty. Nothing downstream can catch that, because
  // there is nothing wrong downstream.
  //
  // WHY IT MAY NOT BE FATAL ON SIGHT EITHER, which is what shipped first and is the
  // cost this change buys back. `groups` is the only unbounded read of the four (a
  // whole-tenant list, so the likeliest to time out) and it is read by NINE pages —
  // but not by the (app) layout, and not by the two routes that matter at a venue:
  // /events/[id] and /events/[id]/run-order/live, which between them read
  // ws.membership, ws.tenant and ws.perms and nothing else. When staff press เริ่ม,
  // /api/notify fans a link to the show-caller out to ~19 phones at once. Failing on
  // sight meant one statement timeout on a select those phones never use took the
  // live show-caller down for all of them, mid-festival, on a page that rendered
  // fine the round before. The other three reads have no such route: everything that
  // gets past them needs them.
  //
  // WHY A POISONED FIELD AND NOT A `partial` FLAG. The flag was the obvious shape and
  // it is this project's most common defect: a flag is only as good as the nine call
  // sites that remember to check it, the tenth is written next month, and the tenth
  // gets `[]` — the exact wrong answer above, now with a mechanism in the codebase
  // that says it was considered. The poison inverts that. Forgetting to handle it is
  // not possible: the failure lives in the DATA, so every reader is guarded by
  // construction and every non-reader is provably unaffected, with no call-site edits
  // to get right and none to keep right. A page that reads groups behaves exactly as
  // it did before this change; a page that does not now survives.
  //
  // The honest cost, so it is weighed and not rediscovered: property access is
  // normally safe, and this one is not. It is confined to the failure path — on a
  // healthy read `groups` is an ordinary array with no getter, so spreads, JSON and
  // toEqual behave as they always did — and it is `enumerable`, so a spread of a
  // poisoned workspace raises the real error instead of quietly dropping the field.
  const groupsFailure = readFailure({ "รายชื่อวง": groupsRead }, "getWorkspace");
  if (groupsFailure) {
    // Logged HERE rather than at the access, because the whole point of this change
    // is that some routes never access it. The show-caller staying up must not also
    // make the outage invisible — Next redacts the message in production, so this
    // line is the only thing tying a report ("the dashboard is showing an error") to
    // a cause in the Vercel log, and it must be written even when nobody threw.
    console.error("[CueIQ] getWorkspace read failed:", groupsFailure.message);
  }

  // Past the guards, an empty answer is a real one and keeps its old meaning: a
  // tenants row that is genuinely absent (deleted, or hidden by RLS) still yields
  // `tenant: null` → the join screen, and a label with no bands yet still yields
  // `groups: []` → "ยังไม่มีวง". Only `.error` decides, exactly as in read-guard.
  const tenant = tenantRead.data;
  const groupRoles = (groupRoleRead.data ?? []) as GroupRoleRow[];

  const ws: Workspace = {
    user: base,
    membership: {
      tenant_id: memberRow.tenant_id as string,
      role,
    },
    tenant: (tenant as Tenant) ?? null,
    groups: (groupsRead.data ?? []) as Group[],
    groupRoles,
    // NOT derived from `groups`: perms is role + group_roles, both of which read
    // fine on this path. A poisoned band LIST does not make the permission answer
    // unsafe, and callers that only ask "may I?" must not be taken down by it.
    perms: makePerms(role, groupRoles),
  };
  if (groupsFailure) poisonField(ws, "groups", groupsFailure);
  return ws;
});

/**
 * Replace a resolved field with one that THROWS when it is read.
 *
 * The alternative to a flag nobody checks (see READ 4 above). Three properties are
 * load-bearing and none of them is decoration:
 *   • `enumerable: true` — a spread or a JSON.stringify of the workspace must raise
 *     the real read failure, not silently omit the field and hand the next line an
 *     `undefined` to call `.map()` on.
 *   • `configurable: true` — a test (or a future caller building a derived
 *     workspace) can still redefine it; a locked property would be a second, worse
 *     kind of un-debuggable.
 *   • The SAME Error instance every time, so a page that reads the field twice
 *     reports one cause, and Next attaches one digest to it.
 * Applied only on the failure path, so a healthy workspace is a plain object.
 */
function poisonField<K extends keyof Workspace>(ws: Workspace, key: K, err: Error): void {
  Object.defineProperty(ws, key, {
    get(): never {
      throw err;
    },
    enumerable: true,
    configurable: true,
  });
}

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
