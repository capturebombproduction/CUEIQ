// How a show comes back from its crash-recovery snapshot.
//
// The snapshot is what lets the first device carry its show on after a crash or a
// reload (พี่ 2026-10-04: there is no take-over - the first device is opened again
// and its own snapshot keeps the show going). Its timestamps are absolute, so a page
// back at once (a reload, a renderer that crashed and came straight back) resumes the
// clock and the track where they would be.
//
// ...but only at once (2026-11-05, hunt 13). A page gone for minutes - the PA killed,
// rebooted, its power cut - came back with the row's clock run on through the whole
// outage while the file had stood still: in Auto the song that was cut was over by its
// clock and the next one took over at the first render, its clock running with no sound
// until someone tapped; in Manual the tap played the file from the wall clock, past its
// end - silence. So a page gone longer than RESUME_RUNNING_MS comes back PAUSED on the
// row it stood on, at the position it had when the page was last alive, and plays on
// from there when the operator presses play. It is still THE show: not held, it keeps
// its MAIN. Only the row stops - the show clock keeps real time, the slot did go by.
//
// But a snapshot is also what a REHEARSAL leaves behind when its page is closed with
// the show still running. Opened again hours later at the venue it came back RUNNING,
// and where nothing blocks autoplay (the desktop app) a track started out of the PA
// by itself; in Auto the clock had run on through the whole set in the meantime.
//
// So a snapshot whose page has been gone longer than STALE_RESTORE_MS comes back
// PAUSED where it stopped (พี่ 2026-10-04: "โชว์ค้างเก่า → หยุดไว้ก่อน"): the same row,
// the same position in it, and nothing sounding until someone presses play. Its show
// clock stops for the time the page was gone too - otherwise pressing play and then
// จบโชว์ saved a show three hours longer than anything that ran. A running
// show re-writes its snapshot every SNAPSHOT_ALIVE_MS, so `savedAt` says when its page
// was last alive - not when the show last changed row (one long song is minutes).

/** Gone longer than this, a show comes back paused instead of running on. */
export const STALE_RESTORE_MS = 10 * 60 * 1000;

/** How often a begun show re-writes its snapshot while its page is alive. */
export const SNAPSHOT_ALIVE_MS = 30 * 1000;

/** Gone no longer than this, a running show carries on by its clock. `savedAt` alone can be
 *  one alive interval old, so a page that came straight back reads up to that much. */
export const RESUME_RUNNING_MS = SNAPSHOT_ALIVE_MS + 15 * 1000;

/** The part of a Live / Quick Show state that a restore can change. */
export interface RestorableShow {
  running: boolean;
  startedAt: number | null;
  itemStartedAt: number | null;
  itemElapsedAtPause: number | null;
}

/**
 * The state to restore from a snapshot saved at `savedAt`, and whether it was paused
 * because the page had been gone too long. `stale` is true for ANY show that old, even
 * one that was not running: a Manual cue keeps the previous track sounding with
 * `running: false`, so the caller also drops what was sounding when `stale` is set.
 * `cut`: gone longer than RESUME_RUNNING_MS but not stale - paused on its row the same way,
 * and the caller drops what was sounding the same way, but it is not held (see the top).
 */
export function restoreShow<S extends RestorableShow>(
  s: S,
  savedAt: number,
  now: number = Date.now()
): { state: S; stale: boolean; cut?: true } {
  const gone = now - savedAt;
  if (gone <= RESUME_RUNNING_MS) return { state: s, stale: false };
  if (gone <= STALE_RESTORE_MS) {
    // the show clock (startedAt) stays on real time: the slot went by, Hard Out knows it
    if (!s.running) return { state: s, stale: false, cut: true };
    return { state: { ...s, running: false, itemElapsedAtPause: posAt(s, savedAt) }, stale: false, cut: true };
  }
  // the show clock picks up where it stood when the page was last alive
  const startedAt = s.startedAt != null ? s.startedAt + gone : null;
  if (!s.running) return { state: { ...s, startedAt }, stale: true };
  return { state: { ...s, running: false, startedAt, itemElapsedAtPause: posAt(s, savedAt) }, stale: true };
}

/** Where a running item stood when the page was last alive - not minutes or hours later. */
function posAt(s: RestorableShow, savedAt: number): number {
  return s.itemStartedAt != null
    ? Math.max(0, (savedAt - s.itemStartedAt) / 1000)
    : (s.itemElapsedAtPause ?? 0);
}
