// ---------------------------------------------------------------------------
// Links that lead nowhere — the decidable half of the round-10 finding
// "the bell drops people on a bare English 404".
//
// Three separate roads led to the same dead end, and all three are decided here
// so they can be tested without a browser or a database:
//
//  1) THE SHOW-STARTED BLAST. When the festival board's "เริ่ม" is pressed,
//     /api/notify fans "🔴 งานเริ่มแล้ว (Live)" to the WHOLE label — all 19
//     accounts — but the link it stored was `/events/<entry event>/run-order/live`,
//     where the entry event is whichever ONE band's event the caller happened to
//     open the board from (Overview picks `g.events[0]`). events_select is
//     can_view_group(group_id) (0016_rbac_roles.sql), so a member or Ar of any of
//     the other 7 bands cannot read that row: the live page's `.single()` returns
//     null and calls notFound(). Roughly 12-15 of 19 people got a push on their
//     phone and a Not Found page at the single most attention-heavy moment of the
//     day. `runOrderLinksFor` hands each recipient a destination THEY can open.
//
//  2) THE BELL ITEM WHOSE EVENT IS GONE. notifications.link is plain text with no
//     FK to events (0021_notifications.sql), and deleting an event deletes only
//     the event, so every deleted show leaves its approve/reject notifications
//     pointing at a row that no longer exists. Production is carrying 8 of them;
//     for one Ar account those rows are its ENTIRE bell. Clicking marked them read
//     FIRST and then 404'd, so the only content that account had disappeared into a
//     page that does not exist. `notificationReachability` lets the bell say so
//     instead of navigating.
//
//  3) THE 404 ITSELF. The app had no not-found page of its own, so every dead end
//     in the whole product rendered Next's bare English default.
//     `describeDeadEnd` picks the Thai copy for app/not-found.tsx.
//
// A note that matters for (2) and (3): from the client, "the event was deleted"
// and "you may not see this event" are THE SAME OBSERVATION. RLS answers both with
// no row and no error. Do not invent a confidence we do not have — the copy below
// deliberately names both possibilities, because both lead to the same dead end
// and the honest sentence is the one that covers them.
// ---------------------------------------------------------------------------
import { isLabelWide, type Role } from "@/lib/types";

/** The festival live board, as a path. Kept in one place so the notify route and
 *  the tests can't drift from the real route. */
export function runOrderLiveLink(eventId: string): string {
  return `/events/${eventId}/run-order/live`;
}

/** Where anyone who has no openable event of the festival is sent instead. It is
 *  never a 404: /overview renders for label-wide users and for anyone holding a
 *  group_roles row, and redirects (not notFound) to /dashboard for the rest. */
export const RUN_ORDER_FALLBACK_LINK = "/overview";

export type FestivalEvent = { id: string; group_id: string | null };
export type GroupRoleRow = { user_id: string; group_id: string };

/**
 * Resolve the "งานเริ่มแล้ว (Live)" link PER RECIPIENT.
 *
 *  · label-wide (admin / ceo / label_staff) → the entry event; can_view_group is
 *    true for every band, so the deep link they'd expect works.
 *  · a band-tier recipient with a group_roles row on a band that HAS an event in
 *    this festival → that band's own event id. Same board (run_sequence is keyed
 *    on tenant + name + date, not on the event id), reached through a row RLS
 *    lets them read.
 *  · everyone else — members of bands not playing this festival, and anyone whose
 *    roles we could not resolve → RUN_ORDER_FALLBACK_LINK.
 *
 * Degradation is deliberate: if the caller passes empty arrays because a lookup
 * failed, band-tier users get /overview rather than a link that 404s. A slightly
 * duller destination is always better than a dead one, and this fires on show day.
 *
 * When a recipient is an Ar for two bands in the same festival the smallest event
 * id wins — arbitrary but STABLE, so the row in their bell and the push on their
 * phone always agree.
 */
export function runOrderLinksFor(opts: {
  recipientIds: readonly string[];
  /** tenant_members rows for the recipients (role decides label-wide standing) */
  members: readonly { user_id: string; role: string | null }[];
  /** every event of this festival (tenant + name + date), with its band */
  festivalEvents: readonly FestivalEvent[];
  /** group_roles rows joining recipients to the festival's bands */
  groupRoles: readonly GroupRoleRow[];
  /** the event the board was opened from — the only id we know is a real event */
  entryEventId: string;
}): Map<string, string> {
  const { recipientIds, members, festivalEvents, groupRoles, entryEventId } = opts;

  const labelWide = new Set(
    members
      // isLabelWide() mirrors 0016's is_label_wide for the roles this product
      // actually issues. The SQL superset (platform_admin / tenant_owner) is not in
      // the Role union; such a user simply falls through to /overview, which is a
      // duller destination but never a dead one.
      .filter((m) => isLabelWide((m.role ?? null) as Role | null))
      .map((m) => m.user_id)
  );

  // band → the openable event of this festival for that band (smallest id wins)
  const eventByGroup = new Map<string, string>();
  for (const ev of festivalEvents) {
    if (!ev.group_id || !ev.id) continue;
    const cur = eventByGroup.get(ev.group_id);
    if (!cur || ev.id < cur) eventByGroup.set(ev.group_id, ev.id);
  }

  const bandsOf = new Map<string, string[]>();
  for (const gr of groupRoles) {
    const list = bandsOf.get(gr.user_id);
    if (list) list.push(gr.group_id);
    else bandsOf.set(gr.user_id, [gr.group_id]);
  }

  const out = new Map<string, string>();
  for (const uid of recipientIds) {
    if (labelWide.has(uid)) {
      out.set(uid, runOrderLiveLink(entryEventId));
      continue;
    }
    let best: string | null = null;
    for (const gid of bandsOf.get(uid) ?? []) {
      const evId = eventByGroup.get(gid);
      if (evId && (!best || evId < best)) best = evId;
    }
    out.set(uid, best ? runOrderLiveLink(best) : RUN_ORDER_FALLBACK_LINK);
  }
  return out;
}

/**
 * The BODY that goes with a "🔴 งานเริ่มแล้ว (Live)" notification, decided from the
 * same per-recipient link so the two can never disagree.
 *
 * The link became per-recipient (runOrderLinksFor) while the body stayed one shared
 * string, so all 19 accounts were still told "เปิดดูคิวงานสดได้เลย" — including the
 * ones routed to RUN_ORDER_FALLBACK_LINK, whose destination has no way into the live
 * board at all: components/overview/overview-client.tsx gates the "คุมคิว (Live)"
 * control behind canApproveEvents and the per-event live link behind isLabelWide.
 * A member of a band that is not playing this festival tapped a push promising the
 * live cue and arrived on an Overview with no such button anywhere. Only promise the
 * board to the people whose link actually opens it.
 */
export function runOrderPushBody(eventName: string, link: string): string {
  const name = eventName || "งาน";
  return link === RUN_ORDER_FALLBACK_LINK
    ? `${name} — งานเริ่มแล้ว`
    : `${name} — เปิดดูคิวงานสดได้เลย`;
}

// ---------------------------------------------------------------------------
// (2) Is this bell item still openable?
// ---------------------------------------------------------------------------

/** Pull the event id out of an in-app link, if it addresses one. Covers both
 *  shapes the notify route stores: `/events/<id>` and `/events/<id>/run-order/live`. */
export function eventIdFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const m = /^\/events\/([0-9a-fA-F-]{36})(?:[/?#]|$)/.exec(link);
  return m ? m[1] : null;
}

/**
 * "ok"      — nothing suggests this leads nowhere; navigate as before.
 * "unknown" — we could not check (no probe result yet, or a result we don't trust).
 *             NAVIGATE, exactly as the app did before, and never downgrade an item
 *             on a guess — but do not WRITE on one either; see mayMarkRead below.
 * "gone"    — the target event is not readable by this user: deleted, or belonging
 *             to a band they may not see. Both end in notFound(), so both must
 *             stop the click.
 *
 * `viewableEventIds` is null whenever the probe is untrustworthy — an errored
 * read, or an empty one taken without a live session (supabase-js falls back to
 * the anon key when getSession() returns null and RLS then answers `[]` with no
 * error; believing that would gray out every item in a perfectly healthy bell).
 */
export type Reachability = "ok" | "unknown" | "gone";

export function notificationReachability(
  link: string | null | undefined,
  viewableEventIds: ReadonlySet<string> | null
): Reachability {
  const id = eventIdFromLink(link);
  if (!id) return "ok"; // /library, /overview, or no link at all — nothing to check
  if (!viewableEventIds) return "unknown";
  return viewableEventIds.has(id) ? "ok" : "gone";
}

/**
 * May a click on this item MARK IT READ?
 *
 * Navigating and writing are NOT the same decision, and treating them as one is the
 * whole of the second time this bug shipped. The bell's reachability probe is a
 * second, strictly sequential round trip: the notifications SELECT lands, the unread
 * badge paints — which is exactly what makes someone tap — and only THEN does the
 * events probe go out. For that window (1-3s on venue wifi, and it reopens every
 * time a new item brings a new event id into the set) the answer is "unknown", and
 * "unknown" was allowed to authorise the write. So on every page load the Ar whose
 * entire bell is the eight deleted 🧪 TEST FEST rows could still mark one read on
 * the way to a 404 — the destruction the guard was written to stop, in the one
 * window the bell is most likely to be used.
 *
 * Failing open on NAVIGATION is right: a wrong 404 is a Thai page with a way back.
 * Failing open on the WRITE is not: read_at is the item's only unread flag and
 * nothing in the product sets it back. So the write needs a real answer — "ok" —
 * and never a guess. An item left unread costs one more tap; an item wrongly marked
 * read is gone from the badge for good.
 */
export function mayMarkRead(reach: Reachability): boolean {
  return reach === "ok";
}

/** What the bell says on an item that can no longer be opened. Deliberately names
 *  BOTH causes: from the client they are indistinguishable (see the header note). */
export const UNREACHABLE_NOTE = "งานนี้ถูกลบไปแล้ว หรือคุณไม่มีสิทธิ์เปิดดู";

// ---------------------------------------------------------------------------
// (3) The 404 page's copy
// ---------------------------------------------------------------------------

export type DeadEnd = {
  heading: string;
  detail: string;
  /** somewhere the user can actually GO from here */
  backHref: string;
  backLabel: string;
};

/** Route segments the app really owns. A dead end under one of these is a missing
 *  or forbidden RECORD; anything else is a URL the product simply doesn't have. */
const APP_AREAS = new Set([
  "dashboard",
  "overview",
  "events",
  "library",
  "groups",
  "practice",
  "admin",
  "crew",
  "share",
]);

/**
 * Pick the Thai copy for app/not-found.tsx from the path alone — that is genuinely
 * all a not-found boundary is given. Three honest cases:
 *
 *  · an event URL      → the event is gone OR not yours (indistinguishable); the
 *                        useful next step is Overview, which lists what IS yours.
 *  · another app area  → same ambiguity, one level vaguer, back to Dashboard.
 *  · anything else     → this address does not exist in the product at all. Here we
 *                        CAN be definite, so be definite; a vague "หรือไม่มีสิทธิ์"
 *                        on a plain typo just makes people think they're locked out.
 */
export function describeDeadEnd(pathname: string | null | undefined): DeadEnd {
  const clean = (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean);
  const area = segments[0] ?? "";

  if (area === "events" && segments.length > 1) {
    return {
      heading: "ไม่พบงานนี้",
      detail:
        "งานนี้อาจถูกลบไปแล้ว หรือบัญชีของคุณไม่มีสิทธิ์เข้าถึงงานของวงนี้ — ถ้ามาจากลิงก์แจ้งเตือนเก่า ลิงก์นั้นใช้ไม่ได้อีกแล้ว",
      backHref: "/overview",
      backLabel: "ไปหน้าภาพรวม",
    };
  }

  if (APP_AREAS.has(area) && segments.length > 1) {
    return {
      heading: "ไม่พบรายการนี้",
      detail:
        "รายการนี้อาจถูกลบไปแล้ว หรือบัญชีของคุณไม่มีสิทธิ์เข้าถึง — ลองกลับไปเลือกจากหน้าหลักอีกครั้ง",
      backHref: "/dashboard",
      backLabel: "กลับหน้าหลัก",
    };
  }

  return {
    heading: "ไม่พบหน้านี้",
    detail: "ไม่มีหน้านี้ในระบบ — ลิงก์อาจพิมพ์ผิด หรือถูกย้ายไปแล้ว",
    backHref: "/dashboard",
    backLabel: "กลับหน้าหลัก",
  };
}
