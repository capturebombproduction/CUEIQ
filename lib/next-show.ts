// What the "งานถัดไป" banner tells a band member at a glance.
//
// Measured 2026-10-01 on Seishin Kakumei's shows: the band is called about two
// hours before it goes on (arrive/dressing 11:20 for a 13:20 stage; 11:00 for
// 13:00), and one show had no stage time at all, only its schedule. The banner
// used to print show_start_time alone — the one time a member does NOT need to
// be anywhere by — so the call time, the question every member opens the app
// with, took a tap into the show and a read down the schedule.
import { shortClock } from "@/lib/time";

/** The call time of each show: its earliest timed schedule row ("HH:MM:SS"). */
export function earliestStartByEvent(
  rows: { event_id: string; start_time: string | null }[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.start_time) continue;
    const cur = out[r.event_id];
    // "HH:MM:SS" strings order the same as the times they spell.
    if (cur === undefined || r.start_time < cur) out[r.event_id] = r.start_time;
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
