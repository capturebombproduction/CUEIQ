// lib/song-signal.ts - what the NOW card says about where the song is, and what NEXT says
// about how loud the next song is against this one.
import { describe, it, expect } from "vitest";
import { sectionAt, loudnessDelta, songSignalMap, beatAt, waveOverBlock } from "./song-signal";

const marks = [
  { label: "INTRO", at: 0 },
  { label: "VERSE 1", at: 14 },
  { label: "CHORUS", at: 84 },
];

describe("sectionAt", () => {
  it("names the section it is in, the next one, and how long until it", () => {
    expect(sectionAt(marks, 72)).toEqual({ now: "VERSE 1", next: "CHORUS", inSec: 12 });
    expect(sectionAt(marks, 14)).toEqual({ now: "VERSE 1", next: "CHORUS", inSec: 70 }); // on the mark = in it
    expect(sectionAt(marks, 100)).toEqual({ now: "CHORUS", next: null, inSec: null });
  });

  it("before the first mark there is no section yet - only the next one", () => {
    expect(sectionAt([{ label: "VERSE", at: 10 }], 4)).toEqual({ now: null, next: "VERSE", inSec: 6 });
    expect(sectionAt([], 4)).toEqual({ now: null, next: null, inSec: null });
  });
});

describe("loudnessDelta", () => {
  const s = (lufs: number | null) => ({ lufs, peaks: null, beatOffset: null, bpm: null });
  it("is the next song minus this one, to a tenth of a dB", () => {
    expect(loudnessDelta(s(-11.2), s(-14.3))).toBe(3.1);
    expect(loudnessDelta(s(-16), s(-14))).toBe(-2);
  });
  it("says nothing unless BOTH songs are measured", () => {
    expect(loudnessDelta(s(null), s(-14))).toBeNull();
    expect(loudnessDelta(s(-14), s(null))).toBeNull();
    expect(loudnessDelta(undefined, s(-14))).toBeNull();
  });
});

describe("songSignalMap", () => {
  it("carries each song's 0045 analysis and tempo by id, nulls for the unmeasured", () => {
    const m = songSignalMap([
      { id: "a", lufs: -7.3, peaks: "ABC", beat_offset: 0.32, bpm: 171 },
      { id: "b", lufs: undefined, peaks: undefined, beat_offset: undefined, bpm: undefined },
    ]);
    expect(m.a).toEqual({ lufs: -7.3, peaks: "ABC", beatOffset: 0.32, bpm: 171, duration: null });
    expect(m.b).toEqual({ lufs: null, peaks: null, beatOffset: null, bpm: null, duration: null });
  });

  it("carries the file's own length; a 0 length is unknown", () => {
    const m = songSignalMap([
      { id: "a", lufs: null, peaks: null, beat_offset: null, bpm: null, duration_seconds: 312 },
      { id: "b", lufs: null, peaks: null, beat_offset: null, bpm: null, duration_seconds: 0 },
    ]);
    expect(m.a.duration).toBe(312);
    expect(m.b.duration).toBeNull();
  });
});

describe("waveOverBlock (the waveform on the item's own clock)", () => {
  const L = [0.1, 0.2, 0.3, 0.4]; // a 4-point file

  it("a file as long as the block: one point per column, as before", () => {
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: 40, columns: 4 })).toEqual(L);
  });

  it("a 5-minute backing track in a 2:30 MC slot: only its first half is heard, so only that is drawn", () => {
    // file 80 s, block 40 s: the four columns cover the file's first 40 s = its first two points
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: 80, columns: 4 })).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it("a file shorter than its slot falls silent after its end - unless the item loops", () => {
    // each column is read at the middle of its slice: 5 s and 15 s into a 20 s file
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: 20, columns: 4 })).toEqual([0.2, 0.4, 0, 0]);
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: 20, loop: true, columns: 4 })).toEqual([0.2, 0.4, 0.2, 0.4]);
  });

  it("before the audio starts, silence", () => {
    expect(waveOverBlock(L, { block: 40, start: 20, fileLen: 20, columns: 4 })).toEqual([0, 0, 0.2, 0.4]);
  });

  it("no file length known: the file fills the block after its start (the old drawing)", () => {
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: null, columns: 4 })).toEqual(L);
    expect(waveOverBlock(L, { block: 40, start: 0, fileLen: 0, columns: 4 })).toEqual(L);
  });

  it("nothing to draw: no levels, or no block", () => {
    expect(waveOverBlock([], { block: 40, start: 0, fileLen: 40 })).toEqual([]);
    expect(waveOverBlock(L, { block: 0, start: 0, fileLen: 40 })).toEqual([]);
  });
});

describe("beatAt (the beat light)", () => {
  it("phases from the song's first beat: beat 1..4 of the bar and how far into it", () => {
    // 120 BPM = a beat every 0.5 s, first beat at 0.25 s
    expect(beatAt(0.25, 120, 0.25)).toEqual({ beat: 0, phase: 0 });
    expect(beatAt(0.5, 120, 0.25)).toEqual({ beat: 0, phase: 0.5 });
    expect(beatAt(1.25, 120, 0.25)).toEqual({ beat: 2, phase: 0 });
    expect(beatAt(2.25, 120, 0.25)).toEqual({ beat: 0, phase: 0 }); // the next bar's 1
  });
  it("stays dark before the first beat, or without a tempo", () => {
    expect(beatAt(0.1, 120, 0.25)).toBeNull();
    expect(beatAt(5, 0, 0)).toBeNull();
    expect(beatAt(Number.NaN, 120, 0)).toBeNull();
  });
});
