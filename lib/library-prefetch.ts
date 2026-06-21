// Pre-cache a band's WHOLE song library onto this device, on app open, so both
// Practice Mode and Live Mode play instantly from local storage instead of
// downloading a 27–88 MB WAV each time. Fills the path-keyed cache in
// lib/song-cache.ts. Idempotent (skips anything already cached), sequential
// (one big WAV at a time), and cancellable.

import { downloadEventAudio } from "./audio-remote";
import { cacheSongBlob, listCachedSongPaths } from "./song-cache";

export interface LibraryTarget {
  path: string; // R2 object key (version-stamped)
  name: string | null;
}

export interface LibraryProgress {
  total: number; // files that need downloading this run
  done: number;
  failed: number;
  currentName?: string | null;
}

export interface LibraryReadiness {
  total: number; // library songs with audio
  cached: number; // already on this device
  missing: number;
}

/** How much of the given library this device already holds, without downloading. */
export async function getLibraryReadiness(
  targets: LibraryTarget[]
): Promise<LibraryReadiness> {
  const have = await listCachedSongPaths();
  let cached = 0;
  for (const t of targets) if (have.has(t.path)) cached++;
  return { total: targets.length, cached, missing: targets.length - cached };
}

/**
 * Download every not-yet-cached library file into the song cache. `onProgress`
 * fires around each download; `isCancelled` lets the caller abort between files.
 * Returns counts. Audio is the only resource a band has today, so "audio first"
 * is simply: this is the audio.
 */
export async function prefetchLibrary(
  targets: LibraryTarget[],
  opts: {
    onProgress?: (p: LibraryProgress) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<{ fetched: number; skipped: number; failed: number }> {
  const { onProgress, isCancelled } = opts;
  if (targets.length === 0) return { fetched: 0, skipped: 0, failed: 0 };

  const have = await listCachedSongPaths();
  // De-dupe by path (the same library file can back several songs) and drop hits.
  const seen = new Set<string>();
  const need = targets.filter((t) => {
    if (!t.path || have.has(t.path) || seen.has(t.path)) return false;
    seen.add(t.path);
    return true;
  });
  const skipped = targets.length - need.length;
  const total = need.length;

  let fetched = 0;
  let failed = 0;
  onProgress?.({ total, done: 0, failed: 0 });
  for (const t of need) {
    if (isCancelled?.()) break;
    onProgress?.({ total, done: fetched, failed, currentName: t.name });
    try {
      const blob = await downloadEventAudio(t.path);
      if (isCancelled?.()) break;
      await cacheSongBlob(t.path, blob, t.name);
      fetched++;
    } catch {
      failed++;
    }
    onProgress?.({ total, done: fetched, failed, currentName: t.name });
  }
  return { fetched, skipped, failed };
}
