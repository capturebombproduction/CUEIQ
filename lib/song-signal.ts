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

/** A practice-room section marker (song_markers, 0023): a label at a time in the song. */
export interface LiveMarker {
  label: string;
  /** seconds (into the song's audio; Live passes block seconds to the NOW card) */
  at: number;
}

/** Where the song is: the section it is in and the next one, from markers in song seconds. */
export function sectionAt(
  markers: readonly LiveMarker[],
  t: number
): { now: string | null; next: string | null; inSec: number | null } {
  let now: string | null = null;
  let next: LiveMarker | null = null;
  for (const m of markers) {
    if (m.at <= t) now = m.label;
    else if (!next) next = m;
  }
  return { now, next: next?.label ?? null, inSec: next ? Math.max(0, next.at - t) : null };
}

/** Which beat of the bar (0-3) and how far into it (0-1), or null before the first beat. */
export function beatAt(t: number, bpm: number, offset: number): { beat: number; phase: number } | null {
  if (!(bpm > 0) || !Number.isFinite(t) || t < offset) return null;
  const beats = ((t - offset) * bpm) / 60;
  return { beat: Math.floor(beats) % 4, phase: beats - Math.floor(beats) };
}
