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
  /** the FILE's own length, seconds (songs.duration_seconds, read from the file on upload) */
  duration?: number | null;
}
export type SongSignalMap = Record<string, SongSignal>;

export function songSignalMap(
  songs: readonly (Pick<Song, "id" | "lufs" | "peaks" | "beat_offset" | "bpm"> & { duration_seconds?: number | null })[]
): SongSignalMap {
  return Object.fromEntries(
    songs.map((s) => [
      s.id,
      {
        lufs: s.lufs ?? null,
        peaks: s.peaks ?? null,
        beatOffset: s.beat_offset ?? null,
        bpm: s.bpm ?? null,
        duration: s.duration_seconds && s.duration_seconds > 0 ? s.duration_seconds : null,
      },
    ])
  );
}

/**
 * A song's waveform (0-1 levels over the whole FILE) laid across an item's BLOCK, one value per
 * column: column k is the block's k-th slice of time. The audio starts `start` seconds into the
 * block and runs the file's own length - repeating where the item loops (Live sets the player's
 * loop), silent (0) once the file has ended and before it starts. A setlist row's length is the
 * plan, not the file: an MC that plays a 5-minute backing track in a 2:30 slot hears only its
 * first 2:30, and stretching the whole file over the slot drew the chorus where the intro sounds.
 * Without a known file length the file is taken to fill the block after `start` (the old way).
 */
export function waveOverBlock(
  levels: readonly number[],
  o: { block: number; start: number; fileLen: number | null | undefined; loop?: boolean; columns?: number }
): number[] {
  const n = levels.length;
  const cols = Math.max(1, Math.floor(o.columns ?? n));
  if (n === 0 || !(o.block > 0)) return [];
  const start = Math.max(0, o.start || 0);
  const len = o.fileLen && o.fileLen > 0 ? o.fileLen : o.block - start;
  if (!(len > 0)) return new Array(cols).fill(0);
  const out: number[] = [];
  for (let k = 0; k < cols; k++) {
    let a = ((k + 0.5) / cols) * o.block - start;
    if (a < 0) {
      out.push(0);
      continue;
    }
    if (a >= len) {
      if (!o.loop) {
        out.push(0);
        continue;
      }
      a %= len;
    }
    out.push(levels[Math.min(n - 1, Math.floor((a / len) * n))]);
  }
  return out;
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
