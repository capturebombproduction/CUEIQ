import { parseClockToSeconds } from "@/lib/time";

// Where a schedule row falls in its show's day - pure clock arithmetic, no Supabase, so the
// public share page (a server component) and the Excel export can sort by it without
// pulling lib/clone-event's browser client along (moved out of it 2026-10-27, hunt 6;
// lib/clone-event re-exports all three).

/** Where the source show sits on the clock: the event's own show start — the time
 *  the copy dialog prints as "เดิม …", so "type the new one" means exactly that —
 *  else its earliest stage row. Null when it has neither. (Measuring from the stage
 *  row first put the anchor somewhere the dialog never showed whenever the two
 *  differed: stage 13:00, show start 13:05, type 17:35 → show start 17:40.) */
export function stageAnchorSeconds(
  schedule: readonly { kind?: unknown; start_time?: unknown }[],
  event: { show_start_time?: unknown }
): number | null {
  const showStart = parseClockToSeconds(event.show_start_time as string | null);
  if (showStart != null) return showStart;
  const stages = schedule
    .filter((r) => r.kind === "stage")
    .map((r) => parseClockToSeconds(r.start_time as string | null))
    .filter((s): s is number => s != null);
  return stages.length ? Math.min(...stages) : null;
}

/** Seconds from `fromSec` to `toSec` the short way round the clock: −12 h … +12 h.
 *  The rule lib/next-show.ts callTimeOf counts a show's day by — a 00:30 booth after
 *  a 23:00 set is +1:30, not −22:30. */
export function aroundTheClock(fromSec: number, toSec: number): number {
  return ((((toSec - fromSec) % 86400) + 86400 + 43200) % 86400) - 43200;
}

/** Before this hour a row is "after midnight"; from LATE_SHOW_SEC a show is an evening one. */
const SMALL_HOURS_END_SEC = 6 * 3600;
const LATE_SHOW_SEC = 15 * 3600;

/**
 * Where a row falls in its show's day, for sorting. A plain "HH:MM:SS" sort put a late
 * show's after-midnight booth at the TOP of the day, above the call — and a copy moved
 * past midnight (shiftClock wraps) lands exactly there. So the small hours (before
 * 06:00) after an EVENING show (anchor from 15:00, stageAnchorSeconds) count as the next
 * day, and an evening row before a small-hours show as the day before; everything else
 * is the plain clock. (Until 2026-10-27 this was the ±12 h window around the anchor, which
 * also moved a 06:00 call for an 18:30 show, or a 22:30 second stage after a 10:00 one,
 * to the wrong end of the day.) With no anchor it is the plain clock; a row with no time
 * sorts after every timed one.
 */
export function dayOrderSeconds(
  start: string | null | undefined,
  anchorSec: number | null
): number {
  const sec = parseClockToSeconds(start ?? null);
  if (sec == null) return Number.POSITIVE_INFINITY;
  if (anchorSec == null) return sec;
  // …and only when the row really is on the far side of midnight from the show, the short
  // way round the clock: a 05:00 departure for an upcountry 16:00 stage (11 h BEFORE it)
  // printed last, under the booth (2026-10-27 hunt).
  if (anchorSec >= LATE_SHOW_SEC && sec < SMALL_HOURS_END_SEC && aroundTheClock(anchorSec, sec) > 0)
    return sec + 86400;
  if (anchorSec < SMALL_HOURS_END_SEC && sec >= LATE_SHOW_SEC && aroundTheClock(anchorSec, sec) < 0)
    return sec - 86400;
  return sec;
}
