// When is a festival's show REALLY on? (2026-10-26, พี่: "ส่งเฉพาะเมื่อมันอยู่ในวันเวลางานจริงเท่านั้น")
//
// "🔴 งานเริ่มแล้ว" goes to every account in the label the minute the คุมคิว board's first
// row starts. The crew also runs the board as a dry run - backstage, hours before, or the day
// before - and every dry run used to tell the whole label that the show had begun. So the
// announcement is sent only inside the show's own date and time, read from the run order the
// board is running: from a little before its first planned time to a while after its last.
//
// Times are Bangkok wall clock (CueIQ is Thailand-only; Asia/Bangkok has no DST, UTC+7). A
// run order that crosses midnight rolls onto the next day. No date = no way to know the real
// day, so it is never show time.

import { parseClockToSeconds } from "@/lib/time";

/** What the คุมคิว board tells whoever pressed เริ่มงาน when the server held the push back. */
export const NOT_SHOW_TIME_MESSAGE =
  "ยังไม่ใช่วัน-เวลางานจริง — ไม่ได้ส่งแจ้งเตือน “งานเริ่มแล้ว” ถึงทุกคน";

/** The board may go live this long before its first planned time (doors, an early start). */
export const SHOW_LEAD_MS = 30 * 60_000;
/** ...and the first start may still come this long after its last planned time (a late show). */
export const SHOW_TAIL_MS = 60 * 60_000;
/** A clock that goes back by more than this between rows has crossed midnight. */
const ROLLOVER_SEC = 12 * 3600;
const BKK_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;

export interface RunTimes {
  sort_order?: number | null;
  planned_start?: string | null;
  planned_end?: string | null;
}

/** The [from, to] epoch-ms span the festival dated `eventDate` ("YYYY-MM-DD") is on, or
 *  null when it has no date. Rows are read in running order (sort_order); with no planned
 *  time at all the window is the whole Bangkok day. */
export function showTimeWindow(
  eventDate: string | null | undefined,
  rows: readonly RunTimes[]
): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate ?? "");
  if (!m) return null;
  const midnight = Date.UTC(+m[1], +m[2] - 1, +m[3]) - BKK_OFFSET_MS;

  const ordered = [...rows].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  let first: number | null = null;
  let last: number | null = null;
  let prev: number | null = null;
  let day = 0;
  for (const r of ordered) {
    for (const clock of [r.planned_start, r.planned_end]) {
      const sec = parseClockToSeconds(clock);
      if (sec == null) continue;
      if (prev != null && sec < prev - ROLLOVER_SEC) day++;
      prev = sec;
      const at = midnight + day * DAY_MS + sec * 1000;
      if (first == null) first = at;
      last = last == null ? at : Math.max(last, at);
    }
  }
  if (first == null || last == null) return { from: midnight, to: midnight + DAY_MS };
  return { from: first - SHOW_LEAD_MS, to: last + SHOW_TAIL_MS };
}

/** Is `now` inside the show's real date and time? */
export function isShowTime(
  eventDate: string | null | undefined,
  rows: readonly RunTimes[],
  now: number = Date.now()
): boolean {
  const w = showTimeWindow(eventDate, rows);
  return w != null && now >= w.from && now <= w.to;
}
