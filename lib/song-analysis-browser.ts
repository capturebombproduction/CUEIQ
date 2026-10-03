// The browser half of lib/song-analysis.ts: decode an audio file the user just uploaded and
// measure it (loudness, waveform, first beat) for migration 0045's columns. Best-effort by
// design - every failure (no Web Audio, a codec the browser lacks, a phone out of memory)
// returns null and the song simply stays unmeasured, as every song was before 0045.
import { analyzeAudioBuffer, type AudioBufferLike } from "@/lib/song-analysis";
import { detectBeats } from "@/lib/bpm-detect";

/** Above this a decode would hold ~2x the file again in RAM; leave it to the backfill. */
const MAX_BYTES = 300 * 1024 * 1024;

export interface UploadAnalysis {
  lufs: number | null;
  peaks: string;
  beat_offset: number | null;
  bpm: number | null;
}

export async function analyzeAudioFile(file: Blob): Promise<UploadAnalysis | null> {
  if (typeof OfflineAudioContext === "undefined" || file.size === 0 || file.size > MAX_BYTES) return null;
  try {
    // An OfflineAudioContext decodes without opening an output (no autoplay rules, no
    // device), and resamples to 48 kHz - the rate BS.1770's coefficients were printed for.
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const a = await analyzeAudioBuffer(buffer, (b: AudioBufferLike) => detectBeats(b as AudioBuffer));
    return { lufs: a.lufs, peaks: a.peaks, beat_offset: a.beatOffset, bpm: a.bpm };
  } catch {
    return null;
  }
}
