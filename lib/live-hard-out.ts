// Live Mode's Hard Out line (พี่ 2026-10-04): "จบประมาณ 18:27 · ก่อน Hard Out 3:00", and a
// warning once the projection runs past it. Live already projected the show's end (now +
// what is left of this item + every block after it) but never knew the event's Hard Out -
// and the band's shows are slots with a hard out (16:20, 18:30, …).
//
// Only around the show itself: a rehearsal at home days earlier would read "over by 52
// hours". The window is the 18 h before the hard out to the 6 h after it, in THIS device's
// local time; a hard out earlier in the clock than the show start is past midnight (a
// 23:00 show, a 00:30 hard out) and folds to the next day, as computeSetlistTimes does.
import { formatDuration, parseClockToSeconds, shortClock } from "@/lib/time";

const BEFORE_MS = 18 * 60 * 60 * 1000;
const AFTER_MS = 6 * 60 * 60 * 1000;

export interface HardOutReading {
  /** "18:30" */
  clock: string;
  /** the hard out minus the projected end, in seconds: negative = past it */
  marginSec: number;
  over: boolean;
}

/** The event's hard out as epoch ms in local time, or null without a date and a time. */
export function hardOutAtMs(
  eventDate: string | null | undefined,
  showStartTime: string | null | undefined,
  hardOutTime: string | null | undefined
): number | null {
  const hard = parseClockToSeconds(hardOutTime);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate ?? "");
  if (hard == null || !day) return null;
  const start = parseClockToSeconds(showStartTime);
  const fold = start != null && hard < start ? 1 : 0;
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + fold, 0, 0, hard).getTime();
}

/** Where the projected end stands against the hard out - null away from the show. */
export function hardOutReading({
  eventDate,
  showStartTime,
  hardOutTime,
  projectedEndMs,
  nowMs,
}: {
  eventDate: string | null | undefined;
  showStartTime: string | null | undefined;
  hardOutTime: string | null | undefined;
  projectedEndMs: number;
  nowMs: number;
}): HardOutReading | null {
  const at = hardOutAtMs(eventDate, showStartTime, hardOutTime);
  if (at == null || nowMs < at - BEFORE_MS || nowMs > at + AFTER_MS) return null;
  const marginSec = Math.round((at - projectedEndMs) / 1000);
  return { clock: shortClock(hardOutTime), marginSec, over: marginSec < 0 };
}

/** "ก่อน 3:00" / "เกิน 2:10" - the gap as the stats print time (m:ss). */
export function hardOutGap(r: HardOutReading): string {
  return `${r.over ? "เกิน" : "ก่อน"} ${formatDuration(Math.abs(r.marginSec))}`;
}
