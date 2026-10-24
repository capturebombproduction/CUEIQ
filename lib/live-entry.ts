// "เข้าใน 5 4 3 2 1" - the count before Auto takes the next row (พี่ 2026-10-24).
//
// STAGE's NOW card (and CONSOLE's NEXT box) say when the next row comes in, so the LED-screen
// operator can press along with it instead of syncing to the sound. In AUTO the last five
// seconds of `remaining` count down 5 4 3 2 1: `remaining` already ends on the moment the next
// row comes in (live-mode.tsx runBlock: a lead comes off this row's block, a wait is added to
// it), so this needs no clock of its own and a viewer works it out from the same state.
// A row the next one comes in OVER (a negative buffer_before, "เล่นซ้อน") also carries a
// static line all along - "<next> เข้าซ้อน 5 วิ" - and in MANUAL that line says Manual never
// brings it in by itself. Display only: nothing here touches the clock or the audio.

/** How many seconds the count runs before the next row comes in. */
export const ENTRY_COUNT_SEC = 5;

export interface EntryCue {
  /** the row that comes in next */
  title: string;
  /** how many seconds it comes in over the end of this one; 0 = after it */
  leadSec: number;
  /** 5…1 in the last five seconds before Auto takes the next row, else null */
  count: number | null;
  /** Manual: nothing comes in by itself */
  manual: boolean;
}

/**
 * What the NOW card says about the next row, or null for nothing.
 * The count follows the big countdown's own rounding (it shows Math.round(remaining)), so the
 * amber digit and the clock's seconds read the same; "1" holds through the last half second,
 * when the clock already reads 0:00, until the next row comes in.
 */
export function entryCue({
  auto,
  running,
  remaining,
  blockSec,
  next,
}: {
  /** the show runs in AUTO (state.mode === "auto") */
  auto: boolean;
  /** the clock is running (not paused, not before START) */
  running: boolean;
  /** seconds left of this row's run (the NOW countdown) */
  remaining: number;
  /** this row's run, seconds; a row with no time set never counts */
  blockSec: number;
  /** the row after this one: its title and its lead (leadOf), or null on the last row */
  next: { title: string; leadSec: number } | null;
}): EntryCue | null {
  if (!next) return null;
  const leadSec = Number.isFinite(next.leadSec) ? Math.max(0, Math.round(next.leadSec)) : 0;
  const counting =
    auto &&
    running &&
    blockSec > 0 &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    Math.round(remaining) <= ENTRY_COUNT_SEC;
  const count = counting ? Math.max(1, Math.round(remaining)) : null;
  // the static line is for a row the next one comes in over; any other row says nothing
  // until its count
  if (count === null && leadSec === 0) return null;
  return { title: next.title || "—", leadSec, count, manual: !auto };
}

/** The words before the digit ("เข้าซ้อนใน" / "เข้าใน"), or the static line's words. */
export function entryWords(cue: EntryCue): string {
  if (cue.count !== null) return cue.leadSec > 0 ? "เข้าซ้อนใน" : "เข้าใน";
  return `เข้าซ้อน ${cue.leadSec} วิ`;
}
