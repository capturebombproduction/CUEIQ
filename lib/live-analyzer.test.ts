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
  octaveBands,
  SPECTRUM_BANDS,
  spectrumX,
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
  // 48 kHz, 8192-point FFT (the tap's): 4096 bins of 5.86 Hz, bin i covering i ± ½
  const HZ = 24000 / 4096;
  const silent = () => new Float32Array(4096).fill(-Infinity);
  const K1 = SPECTRUM_BANDS.indexOf(1000);

  it("the bars are twelfths of an octave around 1 kHz, 20 Hz to 20 kHz", () => {
    expect(SPECTRUM_BANDS).toHaveLength(121);
    expect(K1).toBe(68);
    expect(SPECTRUM_BANDS[0]).toBeCloseTo(19.69, 2);
    expect(SPECTRUM_BANDS[120]).toBeCloseTo(20158.74, 1);
    SPECTRUM_BANDS.slice(1).forEach((fc, i) => expect(fc / SPECTRUM_BANDS[i]).toBeCloseTo(Math.pow(2, 1 / 12), 9));
    expect(octaveBands(3)).toHaveLength(31);
  });

  it("a frequency label sits over its own bar", () => {
    expect(spectrumX(1000)).toBeCloseTo(68.5 / 121, 9);
    expect(spectrumX(SPECTRUM_BANDS[0])).toBeCloseTo(0.5 / 121, 9);
    expect(spectrumX(2000) - spectrumX(1000)).toBeCloseTo(12 / 121, 9);
  });

  it("a band is the power of the bins inside it, read as a third octave's worth", () => {
    // one 0 dB bin at 1 kHz: its own band only (972-1029 Hz), 4 twelfths to the third = +6 dB
    const bins = silent();
    bins[Math.round(1000 / HZ)] = 0;
    const one = bandLevels(bins, 48000);
    expect(one).toHaveLength(SPECTRUM_BANDS.length);
    expect(one[K1]).toBeCloseTo(6.02, 2);
    expect(one[K1 - 1]).toBe(-Infinity);
    expect(one[K1 + 1]).toBe(-Infinity);
    // two equal bins in one band add up: +3 dB
    bins[Math.round(1015 / HZ)] = 0;
    expect(bandLevels(bins, 48000)[K1]).toBeCloseTo(9.03, 2);
    // a flat spectrum stands exactly as tall as it did under third-octave bars
    const flat = new Float32Array(4096).fill(-40);
    const third = -40 + 10 * Math.log10((1000 * (Math.pow(2, 1 / 6) - Math.pow(2, -1 / 6))) / HZ);
    expect(bandLevels(flat, 48000)[K1]).toBeCloseTo(third, 1);
    expect(bandLevels(flat, 48000, octaveBands(3), 3)[octaveBands(3).indexOf(1000)]).toBeCloseTo(third, 1);
  });

  it("a bin the band's edge cuts is shared with the neighbour, none of it lost or counted twice", () => {
    // 1 kHz's band ends at 1029.3 Hz = bin 175.67: bin 176 (175.5-176.5) is 17 % its, 83 % the next's
    const bins = silent();
    bins[176] = 0;
    const b = bandLevels(bins, 48000);
    const lin = (db: number) => Math.pow(10, db / 10) / 4; // back from "a third octave's worth"
    expect(lin(b[K1])).toBeCloseTo(0.17, 2);
    expect(lin(b[K1 + 1])).toBeCloseTo(0.83, 2);
    expect(lin(b[K1]) + lin(b[K1 + 1])).toBeCloseTo(1, 9);
  });

  it("bands narrower than a bin draw the slope between two bins, not steps of one bin", () => {
    // bins 4 (23.4 Hz) and 5 (29.3 Hz): the 24.8 / 26.3 / 27.8 Hz bands all lie between them
    const bins = silent();
    bins[4] = -20;
    bins[5] = -10;
    const b = bandLevels(bins, 48000);
    const [k1, k2, k3] = [24.8, 26.3, 27.8].map((hz) => SPECTRUM_BANDS.findIndex((fc) => Math.abs(fc - hz) < 0.1));
    expect([k1, k2, k3]).toEqual([4, 5, 6]);
    expect(b[k1]).toBeLessThan(b[k2] - 1);
    expect(b[k2]).toBeLessThan(b[k3] - 1);
    // exactly: the power between the two bins at the band's centre, times the band's width in bins
    const c = SPECTRUM_BANDS[k2] / HZ;
    const width = (SPECTRUM_BANDS[k2] * (Math.pow(2, 1 / 24) - Math.pow(2, -1 / 24))) / HZ;
    expect(width).toBeLessThan(1);
    expect(b[k2]).toBeCloseTo(10 * Math.log10((0.01 * (5 - c) + 0.1 * (c - 4)) * width * 4), 6);
  });

  it("no bins, or no sample rate: every bar is silent", () => {
    expect(bandLevels(new Float32Array(0), 48000).every((v) => v === -Infinity)).toBe(true);
    expect(bandLevels(silent(), 0)).toHaveLength(121);
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
