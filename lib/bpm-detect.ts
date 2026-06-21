// ---------------------------------------------------------------------------
// Tempo (BPM) detection from a decoded AudioBuffer — offline, free, no deps.
//
// Most library songs have no saved BPM, so the practice metronome falls back to
// 100 and feels "off". This estimates the tempo straight from the audio so the
// metronome can lock to the actual song.
//
// Classic Web Audio approach: render the audio through a low-pass (+ high-pass)
// to isolate the kick/bass, pick amplitude peaks with a descending threshold,
// then histogram the intervals between peaks (folded into one octave) and take
// the most common period as the beat. Octave ambiguity is inherent to every BPM
// detector — the metronome UI offers ÷2 / ×2 to fix a half/double guess.
// ---------------------------------------------------------------------------

const ANALYSIS_SECONDS = 120; // analyse at most this much (tempo is ~constant)
const FOLD_LO = 70; // fold the answer into [70, 140) — a neutral musical octave
const FOLD_HI = 140;

type OfflineCtor = typeof OfflineAudioContext;

function getOfflineCtor(): OfflineCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return w.OfflineAudioContext || w.webkitOfflineAudioContext || null;
}

/** Estimate the tempo of a decoded buffer. Returns BPM, or null if unsure. */
export async function detectTempo(buffer: AudioBuffer): Promise<number | null> {
  const sr = buffer.sampleRate;
  const length = Math.min(buffer.length, Math.floor(ANALYSIS_SECONDS * sr));
  if (length < sr * 5) return null; // too short to be reliable

  const Offline = getOfflineCtor();
  if (!Offline) return null;

  const offline = new Offline(1, length, sr);

  // Downmix the analysis window to mono so the filters see one signal.
  const mono = offline.createBuffer(1, length, sr);
  const out = mono.getChannelData(0);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i] / channels;
  }

  const src = offline.createBufferSource();
  src.buffer = mono;
  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 150;
  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 90;
  src.connect(lowpass);
  lowpass.connect(highpass);
  highpass.connect(offline.destination);
  src.start(0);

  const rendered = await offline.startRendering();
  const tempo = mostLikelyTempo(getPeaks(rendered.getChannelData(0), sr), sr);
  if (!tempo) return null;
  return Math.min(240, Math.max(40, Math.round(tempo)));
}

// Peaks above a threshold that starts high and steps down until we have enough.
function getPeaks(data: Float32Array, sr: number): number[] {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > max) max = v;
  }
  if (max === 0) return [];

  const minGap = Math.floor(0.25 * sr); // ignore peaks <250ms apart (<=240 BPM)
  const floor = max * 0.25;
  let threshold = max * 0.9;
  let peaks: number[] = [];
  while (threshold >= floor) {
    peaks = [];
    for (let i = 0; i < data.length; ) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v >= threshold) {
        peaks.push(i);
        i += minGap; // skip past this hit so we don't count it twice
      } else {
        i++;
      }
    }
    if (peaks.length >= 30) break;
    threshold -= max * 0.05;
  }
  return peaks;
}

// Histogram the intervals between nearby peaks; the busiest folded tempo wins.
function mostLikelyTempo(peaks: number[], sr: number): number | null {
  if (peaks.length < 4) return null;
  const counts = new Map<number, number>();
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 1; j <= 10 && i + j < peaks.length; j++) {
      const interval = peaks[i + j] - peaks[i];
      if (interval <= 0) continue;
      let tempo = 60 / (interval / sr);
      while (tempo < FOLD_LO) tempo *= 2;
      while (tempo >= FOLD_HI) tempo /= 2;
      const key = Math.round(tempo);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestCount = -1;
  counts.forEach((count, tempo) => {
    if (count > bestCount) {
      bestCount = count;
      best = tempo;
    }
  });
  return best;
}
