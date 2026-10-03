// Song analysis (migration 0045): measured ONCE from the audio file and kept on the song, so
// every device can use it - including phones, which never hold the audio in Live Mode.
//
//   lufs         integrated loudness, ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms blocks
//                with 75 % overlap, the -70 LUFS absolute gate and the -10 LU relative gate.
//                Live compares the next song with the playing one ("+3.1 dB ดังกว่า").
//   peaks        a PEAK_POINTS-point waveform overview, one base64url character per point:
//                the block's RMS level in dB, -42..0 dBFS mapped to 0-63. Not the sample peak:
//                today's masters sit near 0 dBFS almost throughout (Seishin's measured -5.8 to
//                -7.3 LUFS), so a peak picture is a solid brick; the RMS level still shows the
//                quiet intro, the verse and the chorus the operator is looking for.
//   beat_offset  the first beat lib/bpm-detect.ts tracks; with songs.bpm it phases Live's
//                beat light to the music.
//
// No imports from the app (no "@/" alias, no DOM): the same file runs in the browser after
// an upload (components/song/song-library.tsx) and under plain Node for songs uploaded
// before 0045 (review-shots/song-analysis-backfill.mjs decodes with ffmpeg and calls
// analyzeChannels). Anything browser-only is behind analyzeAudioBuffer's argument.

export const PEAK_POINTS = 200;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Biquad coefficients [b0, b1, b2, a1, a2] (a0 normalised to 1). */
type Biquad = [number, number, number, number, number];

/**
 * The two K-weighting stages of BS.1770 (a high-shelf "head" filter, then a high-pass), designed
 * for THIS sample rate - the standard's printed coefficients are for 48 kHz only. Same design as
 * libebur128, which ffmpeg's ebur128 filter uses.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, highpass];
}

function filterInPlace(x: Float32Array, [b0, b1, b2, a1, a2]: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    x[i] = yi;
  }
}

/**
 * Integrated loudness (LUFS) of up to two channels (mono or stereo; a third channel and on
 * would need BS.1770's surround weights and is ignored). null when nothing passes the
 * absolute gate: silence, or a file shorter than one 400 ms block.
 */
export function integratedLufs(channels: readonly Float32Array[], sampleRate: number): number | null {
  const chans = channels.slice(0, 2);
  if (chans.length === 0 || sampleRate <= 0) return null;
  const len = Math.min(...chans.map((c) => c.length));
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  if (len < block) return null;
  const [shelf, highpass] = kWeighting(sampleRate);
  // Per-hop sums of squares of the K-weighted signal (channels summed with weight 1.0, as
  // BS.1770 gives L and R); a 400 ms block is four consecutive hops.
  const hops = Math.floor(len / hop);
  const hopEnergy = new Float64Array(hops);
  for (const c of chans) {
    const y = Float32Array.from(c.subarray(0, len));
    filterInPlace(y, shelf);
    filterInPlace(y, highpass);
    for (let h = 0; h < hops; h++) {
      let sum = 0;
      const end = (h + 1) * hop;
      for (let i = h * hop; i < end; i++) sum += y[i] * y[i];
      hopEnergy[h] += sum;
    }
  }
  const blocks: number[] = []; // mean square per block (channel-summed)
  for (let b = 0; b + 4 <= hops; b++) {
    blocks.push((hopEnergy[b] + hopEnergy[b + 1] + hopEnergy[b + 2] + hopEnergy[b + 3]) / (4 * hop));
  }
  const loudness = (z: number) => -0.691 + 10 * Math.log10(z);
  const absGated = blocks.filter((z) => z > 0 && loudness(z) > -70);
  if (absGated.length === 0) return null;
  const mean = (zs: number[]) => zs.reduce((a, z) => a + z, 0) / zs.length;
  const relThreshold = loudness(mean(absGated)) - 10;
  const gated = absGated.filter((z) => loudness(z) > relThreshold);
  if (gated.length === 0) return null;
  return Math.round(loudness(mean(gated)) * 10) / 10;
}

/** The floor of the waveform's level scale: a block this quiet or quieter draws flat. */
export const WAVEFORM_FLOOR_DB = -42;

/** The waveform overview: `points` blocks, each the block's RMS level over all channels. */
export function encodeWaveform(channels: readonly Float32Array[], points = PEAK_POINTS): string {
  const len = channels.length ? Math.min(...channels.map((c) => c.length)) : 0;
  let out = "";
  for (let p = 0; p < points; p++) {
    const from = Math.floor((p * len) / points);
    const to = Math.min(len, Math.max(from + 1, Math.floor(((p + 1) * len) / points)));
    let sum = 0;
    let n = 0;
    for (const c of channels) {
      for (let i = from; i < to; i++) sum += c[i] * c[i];
      n += Math.max(0, to - from);
    }
    const db = n > 0 && sum > 0 ? 10 * Math.log10(sum / n) : -Infinity;
    const q = Math.max(0, Math.min(1, (db - WAVEFORM_FLOOR_DB) / -WAVEFORM_FLOOR_DB));
    out += ALPHABET[Math.round(q * 63)];
  }
  return out;
}

/** encodeWaveform back to display heights 0-1 (0 = at or under the floor, 1 = 0 dBFS RMS);
 *  [] for anything that is not a waveform. */
export function decodeWaveform(peaks: string | null | undefined): number[] {
  if (!peaks || !/^[A-Za-z0-9_-]{16,2048}$/.test(peaks)) return [];
  return Array.from(peaks, (ch) => ALPHABET.indexOf(ch) / 63);
}

export interface SongAnalysis {
  lufs: number | null;
  peaks: string;
}

/** What 0045 stores for a decoded file, minus the beat (see analyzeAudioBuffer). */
export function analyzeChannels(channels: readonly Float32Array[], sampleRate: number): SongAnalysis {
  return { lufs: integratedLufs(channels, sampleRate), peaks: encodeWaveform(channels) };
}

/** The minimum of an AudioBuffer this file needs (a real one, or Node's stand-in). */
export interface AudioBufferLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Everything 0045 stores, from a decoded buffer. `detectBeats` is passed in (lib/bpm-detect.ts)
 * so this file stays import-free for Node; a song whose beat cannot be tracked keeps null.
 */
export async function analyzeAudioBuffer(
  buffer: AudioBufferLike,
  detectBeats?: (b: AudioBufferLike) => Promise<{ bpm: number; beats: number[] } | null>
): Promise<SongAnalysis & { beatOffset: number | null; bpm: number | null }> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
  const base = analyzeChannels(channels, buffer.sampleRate);
  let beatOffset: number | null = null;
  let bpm: number | null = null;
  if (detectBeats) {
    try {
      const found = await detectBeats(buffer);
      if (found) {
        bpm = found.bpm;
        if (found.beats.length > 0) beatOffset = Math.round(found.beats[0] * 1000) / 1000;
      }
    } catch {
      /* no beat: the light stays off for this song */
    }
  }
  return { ...base, beatOffset, bpm };
}
