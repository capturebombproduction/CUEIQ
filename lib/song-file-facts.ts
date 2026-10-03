// What a song's row says about its FILE: the file's own length, and migration 0045's
// loudness, waveform and first beat. Live draws the waveform on the item's clock from these
// (lib/song-signal.ts waveOverBlock: songs.duration_seconds IS the file's length there), so
// every path that gives a song a new file has to keep them true:
//
// 1. the write that points the song at the new file also clears the OLD file's numbers
//    (STALE_FILE_FACTS) - a waveform of the last take is worse than none;
// 2. afterwards, in the background and best-effort, writeSongFileFacts measures the new
//    file and writes what it read, only while the song still points at that file (a
//    second upload landing first must not get the first file's numbers).
//
// The library's edit dialog shows the length it detected and lets the user change it, so
// it passes `length: false` - what the user saved there stands.
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectAudioDuration } from "@/lib/audio";
import { analyzeAudioFile } from "@/lib/song-analysis-browser";
import type { Song } from "@/lib/types";
import { wroteNothing } from "@/lib/write-guard";

/** Merged into the write that gives a song a new file: the old file's analysis no longer applies. */
export const STALE_FILE_FACTS = { lufs: null, peaks: null, beat_offset: null } as const;

/** Reading a length is a metadata load; one that never answers must not hang the caller. */
const LENGTH_TIMEOUT_MS = 20_000;

/** The file's length in whole seconds as a media element reads it (the player's own clock), or null. */
export function fileLengthSeconds(file: File, timeoutMs = LENGTH_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    detectAudioDuration(file).then(
      (s) => {
        clearTimeout(timer);
        resolve(s > 0 ? s : null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export type SongFilePatch = Partial<Pick<Song, "duration_seconds" | "lufs" | "peaks" | "beat_offset" | "bpm">>;

export interface SongFileFactsOptions {
  /** write the file's length (default true; the edit dialog keeps what the user saved) */
  length?: boolean;
  /** decode the file for loudness/waveform/beat (default true; heavy for a long WAV) */
  analyze?: boolean;
}

/** What the new file asks of its song row; empty when nothing could be read or nothing changes. */
export async function songFilePatch(
  song: Pick<Song, "duration_seconds" | "bpm">,
  file: File,
  opts: SongFileFactsOptions = {}
): Promise<SongFilePatch> {
  const [seconds, a] = await Promise.all([
    opts.length === false ? null : fileLengthSeconds(file),
    opts.analyze === false ? null : analyzeAudioFile(file),
  ]);
  const patch: SongFilePatch = {};
  if (seconds != null && seconds !== song.duration_seconds) patch.duration_seconds = seconds;
  if (a) {
    patch.lufs = a.lufs;
    patch.peaks = a.peaks;
    patch.beat_offset = a.beat_offset;
    // bpm is the user's (practice mode tunes it): only filled where there is none
    if (song.bpm == null && a.bpm != null) patch.bpm = a.bpm;
  }
  return patch;
}

/** Measure `file` and write it to the song while it still points at `path`. What was written, or null. */
export async function writeSongFileFacts(
  supabase: SupabaseClient,
  song: Pick<Song, "id" | "duration_seconds" | "bpm">,
  path: string,
  file: File,
  opts: SongFileFactsOptions = {}
): Promise<SongFilePatch | null> {
  try {
    const patch = await songFilePatch(song, file, opts);
    if (Object.keys(patch).length === 0) return null;
    const { data, error } = await supabase
      .from("songs")
      .update(patch)
      .eq("id", song.id)
      .eq("audio_path", path)
      .select("id");
    if (error || wroteNothing(data)) return null;
    return patch;
  } catch {
    return null;
  }
}
