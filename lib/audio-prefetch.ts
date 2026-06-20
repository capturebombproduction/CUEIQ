// Pre-cache an event's audio onto THIS device, ahead of the show, so Live Mode
// plays from local storage and never has to download a 27–88 MB WAV over a flaky
// venue Wi-Fi mid-show. Reuses the exact same transport (R2 presigned GET) and
// on-device cache (IndexedDB, keyed `${eventId}::${itemId}`) that Live Mode uses,
// so anything prefetched here is found instantly when Live Mode mounts.
//
// Version-aware: the R2 key carries a random suffix, so a replaced library file
// has a NEW path. We compare the cached path against the event's current path —
// a mismatch re-downloads the newer file (overwriting/deleting the stale blob),
// and a cached item no longer in the setlist is dropped.

import { downloadEventAudio } from "./audio-remote";
import { saveAudio, deleteAudio, listCachedItemPaths } from "./audio-store";
import type { PrefetchTarget } from "./audio-targets";

export type { PrefetchTarget } from "./audio-targets";
export { resolveAudioTargets } from "./audio-targets";

export interface Readiness {
  total: number; // targets that have audio
  ready: number; // cached AND matching the current version
  stale: number; // cached but an older version (needs refresh)
  missing: number; // not cached at all
}

/** Returns how prepared this device is, without downloading anything. */
export async function getReadiness(
  eventId: string,
  targets: PrefetchTarget[]
): Promise<Readiness> {
  let cached: Record<string, string | null> = {};
  try {
    cached = await listCachedItemPaths(eventId);
  } catch {
    /* IndexedDB unavailable → treat as nothing cached */
  }
  let ready = 0;
  let stale = 0;
  let missing = 0;
  for (const t of targets) {
    if (!(t.itemId in cached)) missing++;
    else if (cached[t.itemId] === t.path) ready++;
    else stale++;
  }
  return { total: targets.length, ready, stale, missing };
}

export interface PrefetchProgress {
  total: number; // files that need (re)downloading this run
  done: number; // successfully downloaded so far
  failed: number;
  currentName?: string;
}

export interface PrefetchResult {
  totalTargets: number;
  fetched: number;
  skipped: number; // already fresh
  failed: number;
  removedStale: number; // orphaned cache entries dropped
}

/**
 * Download every missing/outdated file into the on-device cache and drop any
 * cache entry no longer in the setlist. Idempotent: if everything is already the
 * current version this does no network work. `onProgress` fires around each
 * download; `isCancelled` lets the caller abort between files.
 */
export async function prefetchEventAudio(
  eventId: string,
  targets: PrefetchTarget[],
  opts: {
    onProgress?: (p: PrefetchProgress) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<PrefetchResult> {
  const { onProgress, isCancelled } = opts;

  // Safety: never run the orphan-cleanup with an empty target list — that would
  // wipe the event's whole cache. Empty here means "nothing to do" (callers that
  // genuinely have audio always pass a non-empty list), so bail untouched.
  if (targets.length === 0) {
    return { totalTargets: 0, fetched: 0, skipped: 0, failed: 0, removedStale: 0 };
  }

  let cached: Record<string, string | null> = {};
  try {
    cached = await listCachedItemPaths(eventId);
  } catch {
    cached = {};
  }

  // 1) Drop cached files that are no longer in this event's setlist
  //    (item removed, or its song unlinked) so the device doesn't keep junk.
  const wanted = new Set(targets.map((t) => t.itemId));
  let removedStale = 0;
  for (const itemId of Object.keys(cached)) {
    if (!wanted.has(itemId)) {
      try {
        await deleteAudio(eventId, itemId);
        removedStale++;
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Anything whose cached version differs from the current path needs a
  //    (re)download. saveAudio writes the same key, so the newer file replaces
  //    the stale blob — old version gone, latest wins.
  const need = targets.filter((t) => cached[t.itemId] !== t.path);
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
      await saveAudio(eventId, t.itemId, blob, t.name, t.path);
      fetched++;
    } catch {
      failed++;
    }
    onProgress?.({ total, done: fetched, failed, currentName: t.name });
  }

  return { totalTargets: targets.length, fetched, skipped, failed, removedStale };
}
