// ---------------------------------------------------------------------------
// AN APPROVAL REQUEST THAT NOBODY ANSWERS.
//
// WHY THIS EXISTS. On 2026-08-31 a sweep of the real data found "Gorya seitan
// sai" still sitting at `pending_review`, submitted 2026-07-15 for a show on
// 2026-07-19. Six weeks. The Ar did their part, /api/notify told the approvers
// once on the day, and then nothing ever mentioned it again — so the show went
// ahead with a call sheet no admin had ever checked. One of the label's five
// recent submissions, unanswered.
//
// That is the SAME failure this round's headline was about. The feedback inbox
// spoke once and went quiet for two months; the approval queue speaks once and
// goes quiet forever. A queue with no second reminder is a queue nobody reads.
//
// WHAT THIS RULE DELIBERATELY DOES NOT DO — and the restraint is the design:
//
//   • It does not nag about a show that has ALREADY HAPPENED. "Gorya seitan sai"
//     itself would not fire today, and that is correct: the show ran, the
//     paperwork is moot, and a daily push about a July gig is exactly the noise
//     that teaches people to swipe notifications away. Those become a cleanup
//     for a human, once — not a standing alarm.
//   • It does not nag about `in_progress` or `draft`. Nobody has ASKED for
//     anything yet; that is the band's own business, and the deadline reminder in
//     the same cron already covers the case where it is running out of time.
//   • It does not fire on the first day. An admin who gets a submission on
//     Tuesday morning is allowed to answer it Tuesday afternoon without the app
//     poking them. The grace period is what separates a reminder from nagging.
// ---------------------------------------------------------------------------

/** Whole days an approver is given before the app starts reminding them. */
export const APPROVAL_GRACE_DAYS = 2;

/** The columns this decision needs — nothing else is read, so the caller's query
 *  can stay narrow and the rule can be tested without a database. */
export interface ApprovalCandidate {
  id: string;
  status: string;
  /** `YYYY-MM-DD`, or null for an event with no date set. */
  event_date: string | null;
  /**
   * A PROXY for "when it entered pending_review", and the honest name for it.
   * `events` has no status_changed_at, and adding one is a migration for a
   * reminder. The proxy is good because the only writes to this row are the
   * submission itself and later edits to the event — and an edit resetting the
   * clock is right: what the approver is being asked to look at just changed.
   * Child rows (schedule_items, setlist_items, mic_assignments) do NOT touch it,
   * so filling in a call time does not silence the reminder.
   */
  updated_at: string;
}

/** Whole days between `updated_at` and now. Negative (a row stamped in the
 *  future — clock skew between the app server and Postgres) reads as 0, never as
 *  a large positive: a skewed clock must not invent an overdue approval. */
export function daysWaiting(row: Pick<ApprovalCandidate, "updated_at">, now: Date): number {
  const since = Date.parse(row.updated_at);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((now.getTime() - since) / 86_400_000));
}

/**
 * The submissions whose approvers should hear about them again today.
 *
 * `todayISO` is the caller's calendar day as `YYYY-MM-DD`, passed in rather than
 * derived here so this function has no clock of its own and the cron keeps ONE
 * notion of "today" across all three of its blocks (it uses the UTC date; the job
 * runs at 01:00 UTC = 08:00 in Bangkok, so that is the same calendar day the
 * label is living in).
 */
export function approvalsNeedingNag(
  rows: ApprovalCandidate[],
  now: Date,
  todayISO: string,
  graceDays: number = APPROVAL_GRACE_DAYS
): ApprovalCandidate[] {
  return rows.filter((r) => {
    if (r.status !== "pending_review") return false;
    // No date → cannot have passed, but also cannot be complete (the completeness
    // gate requires event_date before anything reaches pending_review), so this is
    // an impossible row rather than a judgement call. Refuse it either way.
    if (!r.event_date) return false;
    // String compare is correct and total for `YYYY-MM-DD`, and avoids inventing a
    // timezone for a plain date column.
    if (r.event_date < todayISO) return false;
    return daysWaiting(r, now) >= graceDays;
  });
}

/** The one-line body an approver sees. Says how long it has waited AND when the
 *  show is, because those two numbers together are the whole decision: three days
 *  waiting on a show next month is not the same as three days on a show tomorrow. */
export function approvalNagBody(
  row: ApprovalCandidate,
  now: Date,
  bandName: string,
  eventName: string
): string {
  const waited = daysWaiting(row, now);
  const who = bandName ? `${eventName} · ${bandName}` : eventName;
  return `${who} — รออนุมัติมา ${waited} วัน · โชว์ ${row.event_date}`;
}
