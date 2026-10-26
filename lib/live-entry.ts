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

import { clockSeconds } from "@/lib/time";

/** How many seconds the count runs before the next row comes in. */
export const ENTRY_COUNT_SEC = 5;

export interface EntryCue {
  /** the row that comes in next */
  title: string;
  /** its place in the running order, when given (AUTO lands past a 0:00 row: autoLandsOn) */
  at?: number;
  /** how many seconds it comes in over the end of this one; 0 = after it */
  leadSec: number;
  /** 5…1 in the last five seconds before Auto takes the next row, else null */
  count: number | null;
  /** Manual: nothing comes in by itself */
  manual: boolean;
}

/**
 * What the NOW card says about the next row, or null for nothing.
 * The count is the big countdown's own number (lib/time.ts clockSeconds, rounded up), so the
 * amber digit and the clock's seconds read the same, each digit lands on its whole second, and
 * the next row comes in on the beat after "1" (Live wakes its clock on those seconds).
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
  /** the row that comes in next: its title, its place (autoLandsOn) and the lead of the row
   *  after this one (leadOf - it is what ends this row's run), or null on the last row */
  next: { title: string; leadSec: number; at?: number } | null;
}): EntryCue | null {
  if (!next) return null;
  const leadSec = Number.isFinite(next.leadSec) ? Math.max(0, Math.round(next.leadSec)) : 0;
  const counting =
    auto &&
    running &&
    blockSec > 0 &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    clockSeconds(remaining) <= ENTRY_COUNT_SEC;
  const count = counting ? Math.max(1, clockSeconds(remaining)) : null;
  // the static line is for a row the next one comes in over; any other row says nothing
  // until its count
  if (count === null && leadSec === 0) return null;
  return { title: next.title || "—", ...(next.at !== undefined ? { at: next.at } : {}), leadSec, count, manual: !auto };
}

/**
 * The row AUTO lands on after row `from`: the next one with a run of its own. A row whose run
 * is 0:00 (no time set, or all of it under the next row's lead) is gone the moment it starts -
 * Auto's advance moves on at once - so the count names the row after it, not a title nobody
 * hears (2026-10-26). The last row is where AUTO stops, whatever its run.
 */
export function autoLandsOn(runOf: (i: number) => number, from: number, total: number): number {
  let i = from + 1;
  while (i < total - 1 && !(runOf(i) > 0)) i++;
  return i;
}

/** The words before the digit ("เข้าซ้อนใน" / "เข้าใน"), or the static line's words. */
export function entryWords(cue: EntryCue): string {
  if (cue.count !== null) return cue.leadSec > 0 ? "เข้าซ้อนใน" : "เข้าใน";
  return `เข้าซ้อน ${cue.leadSec} วิ`;
}
