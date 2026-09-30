// What the "งานถัดไป" banner tells a band member at a glance.
//
// Measured 2026-10-01 on Seishin Kakumei's shows: the band is called about two
// hours before it goes on (arrive/dressing 11:20 for a 13:20 stage; 11:00 for
// 13:00), and one show had no stage time at all, only its schedule. The banner
// used to print show_start_time alone — the one time a member does NOT need to
// be anywhere by — so the call time, the question every member opens the app
// with, took a tap into the show and a read down the schedule.
import { parseClockToSeconds, shortClock } from "@/lib/time";

/**
 * A show's call time: its earliest timed schedule row BEFORE the stage.
 *
 * Counted around the stage, not by the smallest clock string (review 2026-10-01):
 * a 23:00 set called at 21:00 with a 00:30 booth is "นัด 21:00", not 00:30 — and
 * copying a show wraps rows past midnight (lib/clone-event.ts) — while a show
 * whose only timed rows come AFTER the set (booth, photo) has no call time at
 * all, rather than one that tells a member to arrive after their own set.
 *
 * The stage is show_start_time, else the earliest "stage" row (the same anchor
 * the copy dialog uses). With neither, the earliest row is the best there is.
 */
export function callTimeOf(
  rows: { start_time: string | null; kind?: string | null }[],
  stage: string | null | undefined
): string | null {
  const timed = rows.filter((r) => r.start_time && parseClockToSeconds(r.start_time) != null);
  if (timed.length === 0) return null;
  const stageRows = timed.filter((r) => r.kind === "stage").map((r) => r.start_time!).sort();
  const anchor = stage ?? stageRows[0] ?? null;
  const anchorSec = anchor ? parseClockToSeconds(anchor) : null;
  if (anchorSec == null) {
    return timed.map((r) => r.start_time!).sort()[0];
  }
  let best: { t: string; d: number } | null = null;
  for (const r of timed) {
    // the signed distance to the stage, the short way round the clock
    const raw = parseClockToSeconds(r.start_time!)! - anchorSec;
    const d = ((((raw % 86400) + 86400 + 43200) % 86400) - 43200);
    if (d < 0 && (!best || d < best.d)) best = { t: r.start_time!, d };
  }
  return best?.t ?? null;
}

/** callTimeOf for many shows at once: schedule rows tagged with their show. */
export function callTimeByEvent(
  rows: { event_id: string; start_time: string | null; kind?: string | null }[],
  stageByEvent: Record<string, string | null | undefined>
): Record<string, string> {
  const byEvent: Record<string, typeof rows> = {};
  for (const r of rows) (byEvent[r.event_id] ??= []).push(r);
  const out: Record<string, string> = {};
  for (const [id, list] of Object.entries(byEvent)) {
    const call = callTimeOf(list, stageByEvent[id]);
    if (call) out[id] = call;
  }
  return out;
}

/** "นัด 11:20 · ขึ้นเวที 13:20", or whichever half exists; null when neither.
 *  A call time that IS the stage time (no rows before the set) is said once. */
export function showTimesLabel(
  call: string | null | undefined,
  stage: string | null | undefined
): string | null {
  const c = call ? shortClock(call) : "";
  const s = stage ? shortClock(stage) : "";
  if (c && s && c !== s) return `นัด ${c} · ขึ้นเวที ${s}`;
  if (s) return `ขึ้นเวที ${s}`;
  if (c) return `นัด ${c}`;
  return null;
}

/** Which practice room "ซ้อม" opens, per band: the one the band last practised in
 *  (measured: 94 of 97 runs in one room), else the newest room. `rooms` newest
 *  first, `runs` newest first. A band with no room gets no entry — the caller
 *  falls back to the Training list. */
export function practiceRoomByGroup(
  rooms: { id: string; group_id: string }[],
  runs: { event_id: string | null; group_id: string }[]
): Record<string, string> {
  const roomIds = new Set(rooms.map((r) => r.id));
  const out: Record<string, string> = {};
  for (const run of runs) {
    if (run.event_id && roomIds.has(run.event_id) && !(run.group_id in out)) {
      out[run.group_id] = run.event_id;
    }
  }
  for (const room of rooms) {
    if (!(room.group_id in out)) out[room.group_id] = room.id;
  }
  return out;
}
