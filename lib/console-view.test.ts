// lib/console-view.ts - the arithmetic behind Live's CONSOLE board. What the board draws
// (where the window sits, which bar a line is, how far a fader would come down) is decided
// here; a wrong answer here is a playhead in the wrong song or a trim that raises a song.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readLiveView,
  STAGE_MEDIA,
  mmss,
  blockStarts,
  arrangementWindow,
  inWindow,
  rulerMarks,
  barLines,
  barBeat,
  sectionRegions,
  resample,
  waveBars,
  trimFor,
  dbToVolume,
  volumeToDb,
  lufsBar,
  ARRANGEMENT_SPAN,
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

describe("the arrangement", () => {
  it("blocks start where the previous ones end; bad lengths count as nothing", () => {
    expect(blockStarts([92, 228, 0, 214])).toEqual({ starts: [0, 92, 320, 320], total: 534 });
    expect(blockStarts([60, Number.NaN, -5, 30])).toEqual({ starts: [0, 60, 60, 60], total: 90 });
    expect(blockStarts([])).toEqual({ starts: [], total: 0 });
  });

  it("the window follows the playhead with a lead, held inside the show", () => {
    expect(arrangementWindow(0, 3600)).toEqual({ start: 0, span: ARRANGEMENT_SPAN });
    expect(arrangementWindow(1000, 3600)).toEqual({ start: 1000 - 240, span: 1200 });
    // the end of the show: the window stops at the last second, the playhead walks on to it
    expect(arrangementWindow(3500, 3600)).toEqual({ start: 2400, span: 1200 });
    // a show shorter than the span is shown whole
    expect(arrangementWindow(300, 900)).toEqual({ start: 0, span: 900 });
    // nothing planned: a harmless 1 s window, never a division by zero
    expect(arrangementWindow(0, 0)).toEqual({ start: 0, span: 1 });
  });

  it("a block is clipped to the window, and one outside it is not drawn", () => {
    const win = { start: 600, span: 1200 };
    expect(inWindow(600, 300, win)).toEqual({ left: 0, width: 25 });
    expect(inWindow(500, 200, win)).toEqual({ left: 0, width: (100 / 1200) * 100 });
    expect(inWindow(1700, 400, win)).toEqual({ left: (1100 / 1200) * 100, width: (100 / 1200) * 100 });
    expect(inWindow(0, 600, win)).toBeNull();
    expect(inWindow(1800, 60, win)).toBeNull();
    expect(inWindow(900, 0, win)).toBeNull();
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

describe("the clip editor", () => {
  it("bar lines every 4 bars from the song's first beat, in block seconds", () => {
    // 120 BPM: a bar is 2 s; first downbeat 0.5 s into the audio, the audio 8 s into the block
    const lines = barLines(120, 0.5, 8, 20);
    expect(lines).toEqual([
      { at: 8.5, bar: 1 },
      { at: 16.5, bar: 5 },
      { at: 24.5, bar: 9 },
    ]);
  });

  it("no tempo, no first beat, no audio: no grid (never a grid at a guessed tempo)", () => {
    expect(barLines(null, 0.5, 0, 200)).toEqual([]);
    expect(barLines(128, null, 0, 200)).toEqual([]);
    expect(barLines(0, 0.5, 0, 200)).toEqual([]);
    expect(barLines(128, 0.5, 0, 0)).toEqual([]);
  });

  it("a grid is capped, so a nonsense tempo cannot hang the board", () => {
    expect(barLines(100000, 0, 0, 3600, 1).length).toBe(512);
  });

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

describe("guards", () => {
  it("a bar grid every 0 (or fewer) bars is no grid, never an endless loop", () => {
    expect(barLines(120, 0, 0, 60, 0)).toEqual([]);
    expect(barLines(120, 0, 0, 60, -4)).toEqual([]);
  });
});
