// What Live Mode knows about each library song beyond its audio file: the 0045 analysis
// (lib/song-analysis.ts) and the saved tempo. Built from the event bundle's songs by the
// Live pages (web and desktop), so it rides the same cache offline. The waveform stays the
// raw 200-character string until Live decodes the one song that is playing.
import type { Song } from "@/lib/types";

export interface SongSignal {
  lufs: number | null;
  peaks: string | null;
  beatOffset: number | null;
  bpm: number | null;
}
export type SongSignalMap = Record<string, SongSignal>;

export function songSignalMap(
  songs: readonly Pick<Song, "id" | "lufs" | "peaks" | "beat_offset" | "bpm">[]
): SongSignalMap {
  return Object.fromEntries(
    songs.map((s) => [
      s.id,
      { lufs: s.lufs ?? null, peaks: s.peaks ?? null, beatOffset: s.beat_offset ?? null, bpm: s.bpm ?? null },
    ])
  );
}

/** "+3.1 dB" / "−2.0 dB": the next song against the playing one, or null when either is unmeasured. */
export function loudnessDelta(next: SongSignal | undefined, playing: SongSignal | undefined): number | null {
  if (next?.lufs == null || playing?.lufs == null) return null;
  return Math.round((next.lufs - playing.lufs) * 10) / 10;
}
