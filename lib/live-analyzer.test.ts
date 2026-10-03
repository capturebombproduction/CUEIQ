// lib/live-analyzer.ts - what CONSOLE's ANALYZER says about the sound leaving the machine. The
// loudness here is the same standard the song analysis uses (BS.1770 / R128), live; a wrong gate
// or a frame-rate-dependent average would make the integrated value a property of the screen.
import { describe, it, expect } from "vitest";
import {
  loudnessOf,
  tailMeanSquare,
  LoudnessMeter,
  gatedIntegrated,
  loudnessRange,
  bandLevels,
  THIRD_OCTAVES,
  spectrumPos,
  correlation,
  gonioPoints,
  BLOCK_EVERY_MS,
  HISTORY_SECONDS,
} from "./live-analyzer";

/** The mean square that reads `lufs`. */
const z = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);

describe("loudness", () => {
  it("BS.1770's formula, and silence is −Infinity", () => {
    expect(loudnessOf(z(-14))).toBeCloseTo(-14, 6);
    expect(loudnessOf(0)).toBe(-Infinity);
  });

  it("the tail of a buffer: the last 400 ms of what the analyser holds", () => {
    const buf = new Float32Array([1, 1, 1, 1, 0.5, 0.5]);
    expect(tailMeanSquare(buf, 2)).toBeCloseTo(0.25, 6);
    expect(tailMeanSquare(buf, 100)).toBeCloseTo((4 + 0.5) / 6, 6);
  });

  it("a steady signal reads the same momentary, short-term and integrated", () => {
    const m = new LoudnessMeter();
    let r = m.push(0, z(-12), 0.5);
    for (let t = 100; t <= 5000; t += 100) r = m.push(t, z(-12), 0.5);
    expect(r.momentary).toBeCloseTo(-12, 6);
    expect(r.shortTerm).toBeCloseTo(-12, 6);
    expect(r.integrated!).toBeCloseTo(-12, 6);
    expect(r.lra!).toBeCloseTo(0, 6);
    expect(r.peak).toBeCloseTo(-6.02, 2);
  });

  it("blocks are spaced in TIME: a 120 Hz screen weighs a loud second no more than a 30 Hz one", () => {
    const fast = new LoudnessMeter();
    const slow = new LoudnessMeter();
    const feed = (m: LoudnessMeter, every: number) => {
      let r = m.push(0, z(-20), 0);
      for (let t = every; t <= 10_000; t += every) r = m.push(t, t < 2000 ? z(-6) : z(-20), 0);
      return r;
    };
    const a = feed(fast, 1000 / 120);
    const b = feed(slow, 1000 / 30);
    expect(Math.abs(a.integrated! - b.integrated!)).toBeLessThan(0.3);
    // and a frame inside the spacing changes nothing
    const m = new LoudnessMeter();
    m.push(0, z(-20), 0);
    const r = m.push(BLOCK_EVERY_MS / 2, z(0), 0);
    expect(r.momentary).toBeCloseTo(-20, 6);
  });

  it("the integrated value is gated: silence (−70) and the quiet stretches 10 LU under the mean do not count", () => {
    expect(gatedIntegrated([z(-14), z(-14), z(-90), z(-90)])).toBeCloseTo(-14, 6);
    // −30 is far under the mean of (−14, −14, −30): gated out
    expect(gatedIntegrated([z(-14), z(-14), z(-30)])).toBeCloseTo(-14, 6);
    expect(gatedIntegrated([z(-80)])).toBeNull();
    expect(gatedIntegrated([])).toBeNull();
  });

  it("reset() starts the next song from nothing", () => {
    const m = new LoudnessMeter();
    for (let t = 0; t <= 3000; t += 100) m.push(t, z(-6), 1);
    m.reset();
    const r = m.push(3100, z(-20), 0.1);
    expect(r.integrated!).toBeCloseTo(-20, 6);
    expect(r.peak).toBeCloseTo(-20, 6);
  });

  it("loudness range: the 10th-95th percentile spread of the short-term values", () => {
    const shorts = Array.from({ length: 101 }, (_, i) => -20 + i * 0.1); // −20 .. −10
    expect(loudnessRange(shorts)!).toBeCloseTo(8.5, 1);
    expect(loudnessRange([-14, -14])).toBeNull(); // too little to say
  });

  it("the history holds a minute, one bar per second, the newest last", () => {
    const m = new LoudnessMeter();
    let r = m.push(0, z(-30), 0);
    for (let t = 100; t <= 70_000; t += 100) r = m.push(t, t >= 69_000 ? z(-8) : z(-30), 0);
    expect(r.history).toHaveLength(HISTORY_SECONDS);
    expect(r.history.at(-1)!).toBeCloseTo(-8, 6);
    expect(r.history[0]).toBeCloseTo(-30, 6);
  });
});

describe("the spectrum", () => {
  it("bins become third-octave bands by summed power", () => {
    // 48 kHz, 8192-point FFT: 4096 bins of 5.86 Hz. One 0 dB bin at 1 kHz.
    const bins = new Float32Array(4096).fill(-Infinity);
    bins[Math.round(1000 / (24000 / 4096))] = 0;
    const bands = bandLevels(bins, 48000);
    expect(bands).toHaveLength(THIRD_OCTAVES.length);
    expect(bands[THIRD_OCTAVES.indexOf(1000)]).toBeCloseTo(0, 6);
    expect(bands[THIRD_OCTAVES.indexOf(2000)]).toBe(-Infinity);
    // two equal bins in one band add up: +3 dB
    bins[Math.round(1050 / (24000 / 4096))] = 0;
    expect(bandLevels(bins, 48000)[THIRD_OCTAVES.indexOf(1000)]).toBeCloseTo(3.01, 2);
    // a band is a THIRD of an octave: 1200 Hz is the 1250 band's (891-1122 | 1114-1403), not 1000's
    bins[Math.round(1200 / (24000 / 4096))] = 0;
    const third = bandLevels(bins, 48000);
    expect(third[THIRD_OCTAVES.indexOf(1000)]).toBeCloseTo(3.01, 2);
    expect(third[THIRD_OCTAVES.indexOf(1250)]).toBeCloseTo(0, 6);
  });

  it("a band narrower than one bin takes the bin its centre falls in", () => {
    // 48 kHz, 1024-point FFT: 46.9 Hz bins - the 20-40 Hz bands hold no bin edge to edge
    const bins = new Float32Array(512).fill(-Infinity);
    bins[1] = -6;
    expect(bandLevels(bins, 48000)[THIRD_OCTAVES.indexOf(40)]).toBeCloseTo(-6, 6);
  });

  it("the bar scale: −72 dB empty, 0 full", () => {
    expect(spectrumPos(-72)).toBe(0);
    expect(spectrumPos(-36)).toBe(0.5);
    expect(spectrumPos(3)).toBe(1);
    expect(spectrumPos(-Infinity)).toBe(0);
  });
});

describe("the stereo picture", () => {
  const sine = (n: number, k = 1) => Float32Array.from({ length: n }, (_, i) => k * Math.sin(i / 7));

  it("correlation: mono +1, one side inverted −1, silence 0", () => {
    expect(correlation(sine(512), sine(512))).toBeCloseTo(1, 6);
    expect(correlation(sine(512), sine(512, -1))).toBeCloseTo(-1, 6);
    expect(correlation(new Float32Array(512), new Float32Array(512))).toBe(0);
  });

  it("the goniometer: mono stands upright, the left channel alone leans to the top-left", () => {
    const mono = gonioPoints(sine(64), sine(64), 1);
    expect(mono.every((p) => Math.abs(p.x) < 1e-6)).toBe(true);
    expect(Math.max(...mono.map((p) => Math.abs(p.y)))).toBeCloseTo(0.9, 6);
    const left = gonioPoints(sine(64), new Float32Array(64), 1);
    const up = left.filter((p) => p.y > 0.1);
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((p) => p.x < 0)).toBe(true);
    expect(gonioPoints(new Float32Array(64), new Float32Array(64))).toEqual([]);
  });
});
