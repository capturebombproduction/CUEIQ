// ---------------------------------------------------------------------------
// Tempo (BPM) + BEAT detection from a decoded AudioBuffer — offline, free, no deps.
//
// Most library songs have no saved BPM, so the practice metronome falls back to
// 100 and feels off. Worse, even with the right BPM a metronome that FREE-RUNS at
// that tempo drifts off a real recording within a phrase (any small BPM error or
// a non-quantized drummer slides it out of phase). The fix is to find the ACTUAL
// beat times in the audio and click on those.
//
// Two exports:
//   • detectTempo(buffer)  → a single BPM number (used where only the tempo matters).
//   • detectBeats(buffer)  → { bpm, beats[] } — the real beat TIMES in seconds, so
//     the metronome can lock to the music instead of free-running.
//
// Shared pipeline (what real beat-trackers like librosa do):
//   1. Downmix to mono, low-pass ~150Hz to emphasise the kick/bass (the real beat
//      carrier), then build an ONSET-STRENGTH envelope — the half-wave-rectified
//      log-energy difference per short frame (a spike each time new energy hits).
//   2. AUTOCORRELATE that envelope, weighted by a log-normal tempo prior, to get
//      the tempo (beat period). Parabolic interpolation gives sub-frame precision.
//   3. (beats only) DYNAMIC-PROGRAMMING beat tracker (Ellis 2007 / librosa): given
//      the tempo, find the sequence of onset frames that both land on strong onsets
//      AND keep a steady spacing near the beat period — then backtrack to the beat
//      times. This auto-phases (no manual downbeat tap) and never drifts, because
//      every click is pinned to a real onset rather than a free-running clock.
//
// Octave ambiguity (half/double) is inherent to every tempo detector — the
// metronome UI offers ÷2 / ×2 to fix it.
// ---------------------------------------------------------------------------

const ANALYSIS_SECONDS = 120; // tempo-only: analyse at most this much (tempo ~constant)
const BEAT_ANALYSIS_SECONDS = 600; // beats: track the whole song (capped for safety)
const FRAME_SECONDS = 0.005; // ~5ms onset-envelope frames (200 fps)
const MIN_BPM = 50;
const MAX_BPM = 210;
const PRIOR_CENTER = 120; // log-normal tempo prior centre
const PRIOR_WIDTH = 0.9; // in octaves
const DP_TIGHTNESS = 100; // how rigidly the beat tracker holds the tempo (librosa default)

type OnsetData = { onset: Float32Array; fps: number };

/**
 * Mono downmix → ~150Hz low-pass → half-wave-rectified log-energy onset envelope.
 * Returns the RAW (non-negative) envelope at `fps` frames/sec, or null if too
 * short. Callers that need a zero-mean signal (autocorrelation) centre their own
 * copy; the beat tracker wants the non-negative version.
 */
function computeOnsetEnvelope(buffer: AudioBuffer, maxSeconds: number): OnsetData | null {
  const sr = buffer.sampleRate;
  const len = Math.min(buffer.length, Math.floor(maxSeconds * sr));
  if (len < sr * 5) return null; // too short to be reliable

  // mono downmix of the analysis window
  const mono = new Float32Array(len);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / channels;
  }

  // emphasise the low band (kick/bass) — carries the beat far more reliably than
  // vocals/cymbals/distortion. One-pole low-pass, in place.
  const rc = 1 / (2 * Math.PI * 150); // ~150Hz cutoff
  const a = 1 / sr / (rc + 1 / sr);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += a * (mono[i] - lp);
    mono[i] = lp;
  }

  // onset-strength envelope: half-wave-rectified log-energy flux per frame
  const hop = Math.max(1, Math.round(sr * FRAME_SECONDS));
  const frames = Math.floor(len / hop);
  if (frames < 16) return null;
  const onset = new Float32Array(frames);
  let prevLog = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = mono[start + i];
      sum += s * s;
    }
    const curLog = Math.log(1e-6 + Math.sqrt(sum / hop));
    // frame 0 has no predecessor — leave it 0 instead of inventing a giant flux
    // off the silence floor (that phantom spike would become a fake downbeat).
    onset[f] = f === 0 ? 0 : Math.max(0, curLog - prevLog);
    prevLog = curLog;
  }

  return { onset, fps: sr / hop };
}

/**
 * Estimate the tempo (BPM, unrounded) from an onset envelope via weighted
 * autocorrelation. Returns null if it can't lock on.
 */
function estimateBpm(onsetRaw: Float32Array, fps: number): number | null {
  const frames = onsetRaw.length;
  if (frames < 16) return null;

  // zero-mean copy (autocorrelation needs DC removed)
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += onsetRaw[f];
  mean /= frames;
  const onset = new Float32Array(frames);
  for (let f = 0; f < frames; f++) onset[f] = onsetRaw[f] - mean;

  const minLag = Math.max(1, Math.floor((fps * 60) / MAX_BPM));
  const maxLag = Math.min(frames - 1, Math.ceil((fps * 60) / MIN_BPM));
  if (maxLag <= minLag) return null;

  const ac = new Float64Array(maxLag - minLag + 1);
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = 0; f + lag < frames; f++) sum += onset[f] * onset[f + lag];
    const idx = lag - minLag;
    ac[idx] = sum;
    const bpm = (fps * 60) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_CENTER) / PRIOR_WIDTH, 2));
    const score = sum * w;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  if (bestIdx < 0) return null;

  // parabolic interpolation around the peak (on raw AC) for sub-frame precision
  let lag = minLag + bestIdx;
  if (bestIdx > 0 && bestIdx < ac.length - 1) {
    const y0 = ac[bestIdx - 1];
    const y1 = ac[bestIdx];
    const y2 = ac[bestIdx + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (delta > -1 && delta < 1) lag += delta;
    }
  }

  const bpm = (fps * 60) / lag;
  if (!isFinite(bpm) || bpm <= 0) return null;
  return bpm;
}

/**
 * Dynamic-programming beat tracker (Ellis 2007 / librosa). Given the onset
 * envelope and an estimated tempo, returns the beat TIMES in seconds.
 *
 *   localscore  — onset envelope normalised + smoothed by a Gaussian (≈period/32)
 *   cumscore[i] — best total score of a beat sequence ending at frame i
 *   backlink[i] — the beat frame chosen before i
 *
 * Each step picks the predecessor j in [i-2P, i-P/2] (P = beat period in frames)
 * maximising cumscore[j] − tightness·(ln((i−j)/P))², i.e. a strong onset whose
 * spacing stays near the period. We then backtrack from the strongest tail beat.
 */
function trackBeats(onsetRaw: Float32Array, fps: number, bpm: number): number[] {
  const N = onsetRaw.length;
  const period = Math.round((60 * fps) / bpm); // frames per beat
  if (period < 2 || N < 4 * period) return [];

  // localscore: normalise the onset envelope, then Gaussian-smooth it
  let mean = 0;
  for (let i = 0; i < N; i++) mean += onsetRaw[i];
  mean /= N;
  let varSum = 0;
  for (let i = 0; i < N; i++) {
    const d = onsetRaw[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / N) || 1;

  const sw = period / 32; // Gaussian std (frames)
  const half = Math.max(1, Math.ceil(sw * 4)); // window radius (~4 std covers it)
  const win = new Float32Array(2 * half + 1);
  for (let k = -half; k <= half; k++) win[k + half] = Math.exp(-0.5 * (k / sw) * (k / sw));

  const localscore = new Float32Array(N);
  let maxLS = -Infinity;
  for (let i = 0; i < N; i++) {
    let s = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(N - 1, i + half);
    for (let j = lo; j <= hi; j++) s += (onsetRaw[j] / std) * win[j - i + half];
    localscore[i] = s;
    if (s > maxLS) maxLS = s;
  }

  // DP over the beat chain
  const minLag = Math.max(1, Math.round(period / 2));
  const maxLag = Math.round(2 * period);
  const txcost = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = Math.log(lag / period);
    txcost[lag] = -DP_TIGHTNESS * r * r;
  }

  const cumscore = new Float32Array(N);
  const backlink = new Int32Array(N);
  let firstBeat = true;
  for (let i = 0; i < N; i++) {
    let bestCand = -Infinity;
    let bestJ = -1;
    const jStart = Math.max(0, i - maxLag);
    const jEnd = i - minLag;
    for (let j = jStart; j <= jEnd; j++) {
      const cand = cumscore[j] + txcost[i - j];
      if (cand > bestCand) {
        bestCand = cand;
        bestJ = j;
      }
    }
    if (bestJ < 0) {
      cumscore[i] = localscore[i];
      backlink[i] = -1;
    } else {
      cumscore[i] = localscore[i] + bestCand;
      // don't start the chain on a near-silent frame (skips dead intros)
      if (firstBeat && localscore[i] < 0.01 * maxLS) {
        backlink[i] = -1;
      } else {
        backlink[i] = bestJ;
        firstBeat = false;
      }
    }
  }

  // pick the tail: the last strong local maximum of cumscore
  const peakVals: number[] = [];
  for (let i = 1; i < N - 1; i++) {
    if (cumscore[i] > cumscore[i - 1] && cumscore[i] >= cumscore[i + 1]) peakVals.push(cumscore[i]);
  }
  if (!peakVals.length) return [];
  peakVals.sort((a, b) => a - b);
  const medianPeak = peakVals[peakVals.length >> 1];
  const thresh = 0.5 * medianPeak;
  let tail = -1;
  for (let i = N - 2; i >= 1; i--) {
    if (cumscore[i] > cumscore[i - 1] && cumscore[i] >= cumscore[i + 1] && cumscore[i] >= thresh) {
      tail = i;
      break;
    }
  }
  if (tail < 0) return [];

  // backtrack
  const framesOut: number[] = [];
  let i = tail;
  while (i >= 0) {
    framesOut.push(i);
    i = backlink[i];
  }
  framesOut.reverse();
  if (framesOut.length < 2) return [];

  // trim weak boundary beats (silent intro/outro) — drop leading/trailing beats
  // whose onset strength is below half the RMS of all beat strengths.
  let sq = 0;
  for (let k = 0; k < framesOut.length; k++) {
    const v = localscore[framesOut[k]];
    sq += v * v;
  }
  const beatThresh = 0.5 * Math.sqrt(sq / framesOut.length);
  let lo = 0;
  let hi = framesOut.length - 1;
  while (lo < hi && localscore[framesOut[lo]] < beatThresh) lo++;
  while (hi > lo && localscore[framesOut[hi]] < beatThresh) hi--;

  const beats: number[] = [];
  for (let k = lo; k <= hi; k++) beats.push(framesOut[k] / fps);
  return beats;
}

/** Estimate the tempo of a decoded buffer. Returns BPM, or null if unsure. */
export async function detectTempo(buffer: AudioBuffer): Promise<number | null> {
  // Yield once so the caller's "analysing…" spinner can paint before we block.
  await new Promise((r) => setTimeout(r, 0));
  const od = computeOnsetEnvelope(buffer, ANALYSIS_SECONDS);
  if (!od) return null;
  const bpm = estimateBpm(od.onset, od.fps);
  if (bpm == null) return null;
  return Math.min(240, Math.max(40, Math.round(bpm)));
}

/**
 * Detect the tempo AND the actual beat times of a decoded buffer.
 * Returns { bpm, beats } where `beats` is beat positions in seconds (empty if the
 * tracker couldn't lock on — caller should fall back to a free-running metronome
 * at `bpm`). `bpm` is refined from the median tracked beat interval when possible.
 */
export async function detectBeats(
  buffer: AudioBuffer
): Promise<{ bpm: number; beats: number[] } | null> {
  await new Promise((r) => setTimeout(r, 0));
  const od = computeOnsetEnvelope(buffer, BEAT_ANALYSIS_SECONDS);
  if (!od) return null;
  const bpm0 = estimateBpm(od.onset, od.fps);
  if (bpm0 == null) return null;

  const beats = trackBeats(od.onset, od.fps, bpm0);
  if (beats.length < 2) {
    return { bpm: Math.min(240, Math.max(40, Math.round(bpm0))), beats: [] };
  }

  // refine BPM from the actual beat spacing (median interval is robust to outliers)
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  const med = intervals[intervals.length >> 1];
  const bpm = med > 0 ? 60 / med : bpm0;
  return { bpm: Math.min(240, Math.max(40, Math.round(bpm))), beats };
}
