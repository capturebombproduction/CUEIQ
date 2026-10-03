// lib/song-signal.ts - what the NOW card says about where the song is, and what NEXT says
// about how loud the next song is against this one.
import { describe, it, expect } from "vitest";
import { sectionAt, loudnessDelta, songSignalMap, beatAt } from "./song-signal";

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
    expect(m.a).toEqual({ lufs: -7.3, peaks: "ABC", beatOffset: 0.32, bpm: 171 });
    expect(m.b).toEqual({ lufs: null, peaks: null, beatOffset: null, bpm: null });
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
