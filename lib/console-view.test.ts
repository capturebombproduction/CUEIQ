// lib/console-view.ts - the arithmetic behind Live's CONSOLE board. What the board draws
// (how wide a clip is, which bar a beat is, how far a fader would come down) is decided
// here; a wrong answer here is a playhead in the wrong song or a trim that raises a song.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readLiveView,
  STAGE_MEDIA,
  mmss,
  blockStarts,
  timelineLayout,
  rulerMarks,
  barBeat,
  sectionRegions,
  resample,
  waveBars,
  trimFor,
  dbToVolume,
  volumeToDb,
  lufsBar,
  TIMELINE_MIN_SHARE,
  TIMELINE_NOW_SHARE,
} from "./console-view";

describe("the view choice", () => {
  it("only an explicit console is CONSOLE - anything else (nothing stored, junk) is STAGE", () => {
    expect(readLiveView("console")).toBe("console");
    expect(readLiveView("stage")).toBe("stage");
    expect(readLiveView(null)).toBe("stage");
    expect(readLiveView(undefined)).toBe("stage");
    expect(readLiveView("CONSOLE")).toBe("stage");
  });

  it("STAGE_MEDIA is the stage: screen of tailwind.preset.ts, word for word", () => {
    const preset = fs.readFileSync(path.join(process.cwd(), "tailwind.preset.ts"), "utf8");
    expect(preset).toContain(`raw: "${STAGE_MEDIA}"`);
  });
});

describe("the timeline", () => {
  it("blocks start where the previous ones end; bad lengths count as nothing", () => {
    expect(blockStarts([92, 228, 0, 214])).toEqual({ starts: [0, 92, 320, 320], total: 534 });
    expect(blockStarts([60, Number.NaN, -5, 30])).toEqual({ starts: [0, 60, 60, 60], total: 90 });
    expect(blockStarts([])).toEqual({ starts: [], total: 0 });
  });

  // the strip's clips: [left, width] percent, rounded to 2 places
  const slots = (lengths: number[], now: number) => timelineLayout(lengths, now).map((x) => [Math.round(x.left * 100) / 100, Math.round(x.width * 100) / 100]);
  const widths = (lengths: number[], now: number) => timelineLayout(lengths, now).map((x) => x.width);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("the clip on now takes its share of the strip, the others the rest by their length", () => {
    // four 4-minute songs, the second on now: 44 %, and 56 % in three equal parts
    expect(slots([240, 240, 240, 240], 1)).toEqual([
      [0, 18.67],
      [18.67, 44],
      [62.67, 18.67],
      [81.33, 18.67],
    ]);
    // the others by LENGTH: a 6-minute MC is three times a 2-minute song
    const w = widths([240, 360, 120], 0);
    expect(w[0]).toBeCloseTo(TIMELINE_NOW_SHARE * 100, 9);
    expect(w[1] / w[2]).toBeCloseTo(3, 9);
    expect(sum(w)).toBeCloseTo(100, 9);
  });

  it("the clips stand edge to edge in the show's order, whatever is on now", () => {
    const lengths = [87, 230, 205, 228, 180, 241, 236, 262, 249, 150, 233, 226, 251, 244, 60, 238, 230, 120, 241, 435];
    for (const now of [0, 6, 19]) {
      const lay = timelineLayout(lengths, now);
      expect(lay).toHaveLength(20);
      lay.forEach((x, i) => expect(x.left).toBeCloseTo(i === 0 ? 0 : lay[i - 1].left + lay[i - 1].width, 9));
      expect(lay[19].left + lay[19].width).toBeCloseTo(100, 9);
      expect(lay[now].width).toBeCloseTo(44, 9);
    }
  });

  it("no clip is squeezed away: a short row and a 0:00 row keep the minimum", () => {
    // a 70-minute show's 38 s MC would be 0.5 % of the strip; a template row of 0 s, nothing
    const w = widths([240, 38, 0, 2100, 2000], 0);
    expect(w[0]).toBeCloseTo(44, 9);
    expect(w[1]).toBeCloseTo(TIMELINE_MIN_SHARE * 100, 9);
    expect(w[2]).toBeCloseTo(TIMELINE_MIN_SHARE * 100, 9);
    // the two long rows share what the lifted ones left, still by their length
    expect(w[3] + w[4]).toBeCloseTo(56 - 2 * TIMELINE_MIN_SHARE * 100, 9);
    expect(w[3] / w[4]).toBeCloseTo(2100 / 2000, 9);
    expect(sum(w)).toBeCloseTo(100, 9);
    // and a row that IS most of the show does not take the others' minimum either
    const long = widths([3600, 20, 20], 0);
    expect(long[1]).toBeCloseTo(TIMELINE_MIN_SHARE * 100, 9);
    expect(long[0]).toBeCloseTo(100 - 2 * TIMELINE_MIN_SHARE * 100, 9);
  });

  it("a clip already wider than its share keeps its own width (a two-row show)", () => {
    expect(slots([300, 100], 0)).toEqual([
      [0, 75],
      [75, 25],
    ]);
    expect(slots([240], 0)).toEqual([[0, 100]]);
    expect(timelineLayout([], 0)).toEqual([]);
  });

  it("more rows than the minimum has room for share what is left equally - never past the strip", () => {
    const w = widths(new Array(101).fill(60), 50);
    expect(w[50]).toBeCloseTo(44, 9);
    expect(w[0]).toBeCloseTo(0.56, 9);
    expect(sum(w)).toBeCloseTo(100, 9);
  });

  it("nothing on now (the index past the list), or a show with no lengths: every clip still has its place", () => {
    expect(slots([100, 300], -1)).toEqual([
      [0, 25],
      [25, 75],
    ]);
    const w = widths([0, 0, 0], 1);
    expect(w[1]).toBeCloseTo(44, 9);
    expect(w[0]).toBeCloseTo(28, 9);
    expect(sum(w)).toBeCloseTo(100, 9);
    expect(widths([Number.NaN, -5, 60], 2)[2]).toBeCloseTo(100 - 2 * TIMELINE_MIN_SHARE * 100, 9);
  });

  it("ruler marks land on round times, at most ten of them", () => {
    const marks = rulerMarks({ start: 760, span: 1200 });
    expect(marks.length).toBeLessThanOrEqual(10);
    expect(marks[0]).toEqual({ at: 840, pct: (80 / 1200) * 100, label: "14:00" });
    expect(marks.every((m) => m.at % 120 === 0)).toBe(true);
    expect(rulerMarks({ start: 0, span: 300 }).map((m) => m.label)).toEqual([
      "0:00", "0:30", "1:00", "1:30", "2:00", "2:30", "3:00", "3:30", "4:00", "4:30",
    ]);
    expect(mmss(3690)).toBe("61:30");
    expect(mmss(-3)).toBe("0:00");
  });
});

describe("the clip on now", () => {
  it("BAR.BEAT counts from the first beat, 1-based, four to the bar", () => {
    expect(barBeat(0.5, 120, 0.5)).toBe("1.1");
    expect(barBeat(1.0, 120, 0.5)).toBe("1.2");
    expect(barBeat(2.49, 120, 0.5)).toBe("1.4");
    expect(barBeat(2.5, 120, 0.5)).toBe("2.1");
    expect(barBeat(0.4, 120, 0.5)).toBeNull();
    expect(barBeat(10, null, 0.5)).toBeNull();
    expect(barBeat(Number.NaN, 120, 0)).toBeNull();
  });

  it("markers become regions that run to the next marker, the last to the block's end", () => {
    expect(
      sectionRegions(
        [
          { label: "CHORUS", at: 60 },
          { label: "INTRO", at: 4 },
          { label: "OUTRO", at: 300 }, // past the block: dropped
        ],
        200
      )
    ).toEqual([
      { label: "INTRO", start: 4, end: 60 },
      { label: "CHORUS", start: 60, end: 200 },
    ]);
    expect(sectionRegions([{ label: "A", at: 0 }], 0)).toEqual([]);
  });

  it("a waveform resampled keeps each stretch's loudest moment", () => {
    expect(resample([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
    expect(resample([0.5, 1], 4)).toEqual([0.5, 0.5, 1, 1]);
    expect(resample([], 8)).toEqual([]);
  });

  it("the bars path draws one mirrored bar per level, a floor for silence", () => {
    const d = waveBars([0, 1], 0.5, 0.1);
    expect(d).toBe("M0.25 45.20h0.5v9.60h-0.5zM1.25 2.00h0.5v96.00h-0.5z");
    // a range draws only its bars, at their own places (the played / to-come split)
    expect(waveBars([0, 1], 0.5, 0.1, 1)).toBe("M1.25 2.00h0.5v96.00h-0.5z");
    expect(waveBars([0, 1], 0.5, 0.1, 0, 1)).toBe("M0.25 45.20h0.5v9.60h-0.5z");
    expect(waveBars([0, 1], 0.5, 0.1, 2, 9)).toBe("");
  });
});

describe("the set mixer", () => {
  it("a trim only ever brings a song DOWN to the target", () => {
    expect(trimFor(-11.2)).toBe(-2.8);
    expect(trimFor(-14)).toBe(0); // +0, never "−0.0 dB"
    expect(trimFor(-18)).toBe(0);
    expect(trimFor(null)).toBeNull();
    expect(trimFor(Number.NaN)).toBeNull();
  });

  it("dB and the player's volume percent", () => {
    expect(dbToVolume(0)).toBe(100);
    expect(dbToVolume(-6)).toBe(50);
    expect(dbToVolume(-2.8)).toBe(72);
    expect(volumeToDb(100)).toBe(0);
    expect(volumeToDb(50)).toBeCloseTo(-6.02, 2);
    expect(volumeToDb(0)).toBe(-Infinity);
  });

  it("a strip's bar: -30 LUFS empty, -6 full, unmeasured empty", () => {
    expect(lufsBar(-30)).toBe(0);
    expect(lufsBar(-18)).toBe(0.5);
    expect(lufsBar(-3)).toBe(1);
    expect(lufsBar(null)).toBe(0);
  });
});
