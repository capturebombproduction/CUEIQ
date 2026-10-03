// Live CONSOLE's ANALYZER (phase B2): the spectrum, the stereo picture and the loudness of what
// this machine is sending, live. The readings come from lib/live-signal.ts's SignalTap (a COPY of
// the players' output, never in the audio path); what they MEAN is decided here, import-free and
// unit-tested (lib/live-analyzer.test.ts).
//
// Loudness follows ITU-R BS.1770-4 / EBU R128 as lib/song-analysis.ts does for a whole file, live:
//   momentary  the K-weighted mean square of the last 400 ms
//   short-term the last 3 s (here: the mean of the momentary blocks inside it, taken every
//              ~100 ms - a display's approximation of the 3 s window, labelled as such)
//   integrated every momentary block since the song began, gated at −70 LUFS and then at
//              10 LU under their own mean
//   LRA        EBU Tech 3342: the spread (10th to 95th percentile) of the short-term values,
//              gated at −70 LUFS and 20 LU under their mean
// Measured AFTER the fader (the tap applies each player's volume), so it is what the room gets.

/** One reading of the analysis tap (SignalTap.startAnalysis), all of it after the faders. */
export interface AnalysisFrame {
  sampleRate: number;
  /** the summed output's spectrum, dB per bin (AnalyserNode.getFloatFrequencyData) */
  bins: Float32Array;
  /** the last block of left and right samples, read in the same frame (aligned) */
  left: Float32Array;
  right: Float32Array;
  /** the K-weighted mean square of the last 400 ms, L and R summed (BS.1770's z) */
  kMeanSquare: number;
  /** the block's sample peak, linear */
  peak: number;
}
export interface AnalysisSource {
  /** null while the tap cannot read (its AudioContext not running yet) */
  read(): AnalysisFrame | null;
  stop(): void;
}

/** BS.1770's loudness of a channel-summed mean square. */
export const loudnessOf = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);
const energyOf = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);

/** Mean square of the last `n` samples of a buffer (the whole buffer if shorter). */
export function tailMeanSquare(buf: Float32Array, n: number): number {
  const from = Math.max(0, buf.length - Math.max(1, Math.floor(n)));
  let sum = 0;
  for (let i = from; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length > from ? sum / (buf.length - from) : 0;
}

export const ABS_GATE = -70;
const SHORT_TERM_MS = 3000;
/** One momentary block every this often; faster frames are skipped, slower ones simply count. */
export const BLOCK_EVERY_MS = 100;
/** The history strip: one bar per second, a minute of them. */
export const HISTORY_SECONDS = 60;

export interface LoudnessReading {
  momentary: number;
  shortTerm: number;
  integrated: number | null;
  lra: number | null;
  /** the loudest sample since the song began, dBFS (a sample peak, not an oversampled true peak) */
  peak: number;
  /** a minute of momentary loudness, one value per second, oldest first (−Infinity = silence) */
  history: number[];
}

/**
 * The running meter. Feed it one block per frame (push); it keeps BLOCK_EVERY_MS spacing itself,
 * so a 120 Hz screen does not weigh the integrated value four times as heavily as a 30 Hz one.
 * reset() at every new song: an integrated value is a song's, not a set's.
 */
export class LoudnessMeter {
  private blocks: number[] = []; // momentary mean squares since reset (the integrated gate's input)
  private recent: { t: number; z: number }[] = []; // the last 3 s of blocks
  private shorts: number[] = []; // short-term loudness per block (LRA's input)
  private seconds: { sec: number; max: number }[] = [];
  private lastAt = -Infinity;
  private peakLin = 0;
  private last: LoudnessReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: null, lra: null, peak: -Infinity, history: [] };

  reset(): void {
    this.blocks = [];
    this.recent = [];
    this.shorts = [];
    this.lastAt = -Infinity;
    this.peakLin = 0;
    this.last = { ...this.last, momentary: -Infinity, shortTerm: -Infinity, integrated: null, lra: null, peak: -Infinity };
  }

  /** One reading: `z` = the channel-summed K-weighted mean square of the last 400 ms, at `t` ms. */
  push(t: number, z: number, samplePeak: number): LoudnessReading {
    if (samplePeak > this.peakLin) this.peakLin = samplePeak;
    if (t - this.lastAt < BLOCK_EVERY_MS) return { ...this.last, peak: toDbfs(this.peakLin) };
    this.lastAt = t;
    const zz = Number.isFinite(z) && z > 0 ? z : 0;
    const m = loudnessOf(zz);
    if (m > ABS_GATE) this.blocks.push(zz);
    if (this.blocks.length > 36000) this.blocks.splice(0, this.blocks.length - 36000); // an hour of blocks
    this.recent.push({ t, z: zz });
    while (this.recent.length && t - this.recent[0].t > SHORT_TERM_MS) this.recent.shift();
    const s = loudnessOf(this.recent.reduce((a, b) => a + b.z, 0) / this.recent.length);
    if (Number.isFinite(s)) this.shorts.push(s);
    if (this.shorts.length > 36000) this.shorts.splice(0, this.shorts.length - 36000);
    // the history: the loudest momentary value of each wall-clock second
    const sec = Math.floor(t / 1000);
    const cur = this.seconds[this.seconds.length - 1];
    if (cur && cur.sec === sec) cur.max = Math.max(cur.max, m);
    else this.seconds.push({ sec, max: m });
    while (this.seconds.length && sec - this.seconds[0].sec >= HISTORY_SECONDS) this.seconds.shift();
    this.last = {
      momentary: m,
      shortTerm: s,
      integrated: gatedIntegrated(this.blocks),
      lra: loudnessRange(this.shorts),
      peak: toDbfs(this.peakLin),
      history: historyBars(this.seconds, sec),
    };
    return this.last;
  }
}

const toDbfs = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

/** BS.1770's integrated loudness of momentary mean squares (absolute gate already applied or not). */
export function gatedIntegrated(blocks: readonly number[]): number | null {
  const abs = blocks.filter((z) => loudnessOf(z) > ABS_GATE);
  if (abs.length === 0) return null;
  const mean = (zs: readonly number[]) => zs.reduce((a, z) => a + z, 0) / zs.length;
  const rel = loudnessOf(mean(abs)) - 10;
  const gated = abs.filter((z) => loudnessOf(z) > rel);
  return gated.length ? loudnessOf(mean(gated)) : null;
}

/** EBU Tech 3342 loudness range of short-term values (LUFS), or null with too little to say. */
export function loudnessRange(shorts: readonly number[]): number | null {
  const abs = shorts.filter((s) => s > ABS_GATE);
  if (abs.length < 10) return null;
  const rel = loudnessOf(abs.reduce((a, s) => a + energyOf(s), 0) / abs.length) - 20;
  const g = abs.filter((s) => s > rel).sort((a, b) => a - b);
  if (g.length < 2) return null;
  const at = (p: number) => g[Math.min(g.length - 1, Math.max(0, Math.round(p * (g.length - 1))))];
  return at(0.95) - at(0.1);
}

function historyBars(seconds: readonly { sec: number; max: number }[], now: number): number[] {
  const out: number[] = new Array(HISTORY_SECONDS).fill(-Infinity);
  for (const s of seconds) {
    const k = HISTORY_SECONDS - 1 - (now - s.sec);
    if (k >= 0 && k < HISTORY_SECONDS) out[k] = s.max;
  }
  return out;
}

// ── THE SPECTRUM ─────────────────────────────────────────────────────────────────────────
/** The ISO 266 third-octave centres from 20 Hz to 20 kHz (31 bands). */
export const THIRD_OCTAVES = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/**
 * An AnalyserNode's frequency data (dB per bin, getFloatFrequencyData) as third-octave band
 * levels: the power of every bin inside the band summed (a band narrower than one bin - the
 * bottom octaves of a short FFT - takes the bin its centre falls in). dB, −Infinity for silence.
 */
export function bandLevels(binsDb: Float32Array, sampleRate: number, bands: readonly number[] = THIRD_OCTAVES): number[] {
  const n = binsDb.length; // fftSize / 2
  if (n === 0 || !(sampleRate > 0)) return bands.map(() => -Infinity);
  const hzPerBin = sampleRate / 2 / n;
  const edge = Math.pow(2, 1 / 6);
  return bands.map((fc) => {
    const lo = Math.max(0, Math.ceil(fc / edge / hzPerBin));
    const hi = Math.min(n - 1, Math.floor((fc * edge) / hzPerBin));
    let p = 0;
    if (hi >= lo) {
      for (let i = lo; i <= hi; i++) if (Number.isFinite(binsDb[i])) p += Math.pow(10, binsDb[i] / 10);
    } else {
      const i = Math.min(n - 1, Math.round(fc / hzPerBin));
      if (Number.isFinite(binsDb[i])) p = Math.pow(10, binsDb[i] / 10);
    }
    return p > 0 ? 10 * Math.log10(p) : -Infinity;
  });
}

/** A band level's bar height 0-1 on the analyzer's scale (−72..0 dB). */
export const SPECTRUM_FLOOR_DB = -72;
export const spectrumPos = (db: number) =>
  Number.isFinite(db) ? Math.max(0, Math.min(1, (db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB)) : 0;

// ── THE STEREO PICTURE ───────────────────────────────────────────────────────────────────
/** Phase correlation of two equal-length blocks: +1 mono, 0 unrelated, −1 out of phase; 0 for silence. */
export function correlation(l: Float32Array, r: Float32Array): number {
  const n = Math.min(l.length, r.length);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < n; i++) {
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  const d = Math.sqrt(ll * rr);
  return d > 1e-12 ? Math.max(-1, Math.min(1, lr / d)) : 0;
}

/**
 * Goniometer points: each sample pair turned 45° (mid up, side across: a mono signal is a
 * vertical line, the left channel alone leans to the top-left "L"), as -1..1 x / y with y up,
 * scaled so the block's largest excursion reaches `fill` of the scope. Every `step`-th sample.
 */
export function gonioPoints(l: Float32Array, r: Float32Array, step = 4, fill = 0.9): { x: number; y: number }[] {
  const n = Math.min(l.length, r.length);
  let max = 0;
  for (let i = 0; i < n; i += step) max = Math.max(max, Math.abs(r[i] - l[i]), Math.abs(l[i] + r[i]));
  if (max < 1e-6) return [];
  const k = fill / max;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += step) out.push({ x: (r[i] - l[i]) * k, y: (l[i] + r[i]) * k });
  return out;
}
