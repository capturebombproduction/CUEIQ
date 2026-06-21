// ---------------------------------------------------------------------------
// Tempo (BPM) detection from a decoded AudioBuffer — offline, free, no deps.
//
// Most library songs have no saved BPM, so the practice metronome falls back to
// 100 and feels off. This estimates the tempo straight from the audio.
//
// Method: the standard, reliable one (what real beat-trackers like librosa use).
//   1. Downmix to mono, build an ONSET-STRENGTH envelope — energy per short
//      frame, then the half-wave-rectified log-energy difference (a spike each
//      time new energy/percussion hits).
//   2. AUTOCORRELATE that envelope. The lag with the strongest self-similarity is
//      the beat period. (Far more robust than peak-interval histograms, which
//      this replaces.)
//   3. Weight each lag by a log-normal tempo prior centred ~120 BPM so we lock
//      onto a musical tempo, then parabolically interpolate the peak for sub-
//      frame precision.
//
// Octave ambiguity (half/double) is inherent to every tempo detector — the
// metronome UI offers ÷2 / ×2 to fix it.
// ---------------------------------------------------------------------------

const ANALYSIS_SECONDS = 120; // analyse at most this much (tempo is ~constant)
const FRAME_SECONDS = 0.005; // ~5ms onset-envelope frames (200 fps)
const MIN_BPM = 50;
const MAX_BPM = 210;
const PRIOR_CENTER = 120; // log-normal tempo prior centre
const PRIOR_WIDTH = 0.9; // in octaves

/** Estimate the tempo of a decoded buffer. Returns BPM, or null if unsure. */
export async function detectTempo(buffer: AudioBuffer): Promise<number | null> {
  // Yield once so the caller's "analysing…" spinner can paint before we block.
  await new Promise((r) => setTimeout(r, 0));

  const sr = buffer.sampleRate;
  const len = Math.min(buffer.length, Math.floor(ANALYSIS_SECONDS * sr));
  if (len < sr * 5) return null; // too short to be reliable

  // 1a. mono downmix of the analysis window
  const mono = new Float32Array(len);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / channels;
  }

  // 1b. emphasise the low band (kick/bass) — it carries the beat far more
  // reliably than vocals/cymbals/distortion. One-pole low-pass, in place.
  const rc = 1 / (2 * Math.PI * 150); // ~150Hz cutoff
  const a = 1 / sr / (rc + 1 / sr);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += a * (mono[i] - lp);
    mono[i] = lp;
  }

  // 1c. onset-strength envelope: half-wave-rectified log-energy flux per frame
  const hop = Math.max(1, Math.round(sr * FRAME_SECONDS));
  const frames = Math.floor(len / hop);
  if (frames < 16) return null;
  const onset = new Float32Array(frames);
  let prevLog = Math.log(1e-6);
  let mean = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = mono[start + i];
      sum += s * s;
    }
    const curLog = Math.log(1e-6 + Math.sqrt(sum / hop));
    const flux = curLog - prevLog;
    const v = flux > 0 ? flux : 0;
    onset[f] = v;
    mean += v;
    prevLog = curLog;
  }
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] -= mean; // centre (kill DC)

  // 2 + 3. weighted autocorrelation over the plausible lag range
  const fps = sr / hop;
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
  return Math.min(240, Math.max(40, Math.round(bpm)));
}
