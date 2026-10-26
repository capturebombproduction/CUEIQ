import { describe, it, expect } from "vitest";
import { ENTRY_COUNT_SEC, autoLandsOn, entryCue, entryWords } from "./live-entry";

const NEXT = { title: "Seishin Kakumei", leadSec: 0 };
const OVER = { title: "Seishin Kakumei", leadSec: 5 };
const base = { auto: true, running: true, blockSec: 87, next: NEXT };

describe("entryCue · AUTO counts 5 4 3 2 1 into EVERY next row (พี่ 2026-10-24)", () => {
  // Each digit on its whole second (lib/time.ts clockSeconds, rounded up, the big clock's own
  // number): "1" is the last second, and the next row comes in on the beat after it. Rounded to
  // the nearest, "5" came at 5.5 s and "1" at 1.5 s - a press along landed half a second early
  // (2026-10-25 hunt).
  it("counts the last five seconds of the run, each digit on its whole second", () => {
    const at = (remaining: number) => entryCue({ ...base, remaining })?.count ?? null;
    expect(at(30)).toBeNull();
    expect(at(5.4)).toBeNull(); // the clock reads 0:06
    expect(at(5.0000000001)).toBe(5); // a float a hair over is that second
    expect(at(5)).toBe(5); // the clock reads 0:05
    expect(at(4.4)).toBe(5);
    expect(at(4)).toBe(4);
    expect(at(3)).toBe(3);
    expect(at(2.2)).toBe(3);
    expect(at(1.2)).toBe(2);
    expect(at(1)).toBe(1);
    // the last second: the clock reads 0:01 until the next row comes in
    expect(at(0.3)).toBe(1);
    // Auto takes the next row at 0 - nothing past it
    expect(at(0)).toBeNull();
    expect(at(-2)).toBeNull();
    expect(ENTRY_COUNT_SEC).toBe(5);
  });

  it("says nothing before the count on a row the next one simply follows", () => {
    expect(entryCue({ ...base, remaining: 40 })).toBeNull();
  });

  it("counts over a row the next one comes in OVER as well, and words it apart", () => {
    const counting = entryCue({ ...base, next: OVER, remaining: 3 })!;
    expect(counting).toEqual({ title: "Seishin Kakumei", leadSec: 5, count: 3, manual: false });
    expect(entryWords(counting)).toBe("เข้าซ้อนใน");
    expect(entryWords(entryCue({ ...base, remaining: 3 })!)).toBe("เข้าใน");
  });

  it("an overlap row carries its static line all along, the count only at the end", () => {
    const cue = entryCue({ ...base, next: OVER, remaining: 60 })!;
    expect(cue.count).toBeNull();
    expect(entryWords(cue)).toBe("เข้าซ้อน 5 วิ");
  });

  it("never counts in MANUAL: Manual waits for the operator", () => {
    expect(entryCue({ ...base, auto: false, remaining: 3 })).toBeNull();
    const over = entryCue({ ...base, auto: false, next: OVER, remaining: 3 })!;
    expect(over.count).toBeNull();
    expect(over.manual).toBe(true);
  });

  it("never counts on a paused clock, before START, on a row with no time, or on the last row", () => {
    expect(entryCue({ ...base, running: false, remaining: 3 })).toBeNull();
    expect(entryCue({ ...base, running: false, next: OVER, remaining: 3 })!.count).toBeNull();
    expect(entryCue({ ...base, blockSec: 0, remaining: 3 })).toBeNull();
    expect(entryCue({ ...base, next: null, remaining: 3 })).toBeNull();
    expect(entryCue({ ...base, remaining: Number.NaN })).toBeNull();
  });

  it("a nameless next row still reads, and a lead is whole seconds", () => {
    const cue = entryCue({ ...base, next: { title: "", leadSec: 4.6 }, remaining: 50 })!;
    expect(cue.title).toBe("—");
    expect(cue.leadSec).toBe(5);
  });

  it("carries the place of the row it names when given, and only then", () => {
    expect(entryCue({ ...base, next: { ...NEXT, at: 4 }, remaining: 3 })!.at).toBe(4);
    expect(entryCue({ ...base, remaining: 3 })).not.toHaveProperty("at");
  });
});

// 2026-10-26: AUTO goes straight through a row whose run is 0:00 (its advance moves on at once),
// and the count named that row - a title nobody hears - over the one that comes in.
describe("autoLandsOn · the row AUTO comes to", () => {
  const runs = (r: number[]) => (i: number) => r[i];
  it("the next row, when it has a run", () => {
    expect(autoLandsOn(runs([200, 180, 200]), 0, 3)).toBe(1);
  });
  it("past a 0:00 row, and past several", () => {
    expect(autoLandsOn(runs([200, 0, 180, 200]), 0, 4)).toBe(2);
    expect(autoLandsOn(runs([200, 0, 0, 180, 200]), 0, 5)).toBe(3);
  });
  it("past a row with no number at all", () => {
    expect(autoLandsOn(runs([200, Number.NaN, 180]), 0, 3)).toBe(2);
  });
  it("the last row is where AUTO stops, even at 0:00", () => {
    expect(autoLandsOn(runs([200, 0, 0]), 0, 3)).toBe(2);
    expect(autoLandsOn(runs([200, 0]), 0, 2)).toBe(1);
  });
});
