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
//
// Library-centric, so the same master recurs across multiple events (a song's
// setlist items all resolve to one path, see audio-targets.ts). The actual byte
// transfer therefore goes through the SHARED path-keyed cache in song-cache.ts
// first — one download serves every event that plays the song — and only the
// per-event `${eventId}::${itemId}` store below is written once per event.

import { downloadEventAudio } from "./audio-remote";
import { saveAudio, deleteAudio, listCachedEntries, type CachedEntry } from "./audio-store";
import { getCachedSongBlob, cacheSongBlob } from "./song-cache";
import type { PrefetchTarget } from "./audio-targets";

export type { PrefetchTarget } from "./audio-targets";

export interface Readiness {
  total: number; // targets that have audio
  ready: number; // cached AND matching the current version AND holding real bytes
  stale: number; // cached but an older version, or bytes we can't trust (needs refresh)
  missing: number; // not cached at all
}

/** Returns how prepared this device is, without downloading anything. */
export async function getReadiness(
  eventId: string,
  targets: PrefetchTarget[]
): Promise<Readiness> {
  let cached: Record<string, CachedEntry> = {};
  try {
    cached = await listCachedEntries(eventId);
  } catch {
    /* IndexedDB unavailable → treat as nothing cached */
  }
  let ready = 0;
  let stale = 0;
  let missing = 0;
  for (const t of targets) {
    const entry = cached[t.itemId];
    if (!entry) missing++;
    // A suspect record (a picked File = a mere reference to a file on this machine,
    // see CachedEntry.suspect) is NOT พร้อม even when its path matches: the green
    // 8/8 would hide a track that goes silent on stage. Counting it stale is what
    // puts the "เตรียม" button back, so real bytes land while there's still a network.
    else if (entry.path === t.path && !entry.suspect) ready++;
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
 * download; `isCancelled` lets the caller abort between files, and `signal`
 * additionally aborts the transfer IN FLIGHT — without it a black-holed venue
 * network leaves the current file hanging forever and the between-files check
 * never gets its turn.
 */
export async function prefetchEventAudio(
  eventId: string,
  targets: PrefetchTarget[],
  opts: {
    onProgress?: (p: PrefetchProgress) => void;
    isCancelled?: () => boolean;
    signal?: AbortSignal;
  } = {}
): Promise<PrefetchResult> {
  const { onProgress, isCancelled, signal } = opts;

  // Safety: never run the orphan-cleanup with an empty target list — that would
  // wipe the event's whole cache. Empty here means "nothing to do" (callers that
  // genuinely have audio always pass a non-empty list), so bail untouched.
  if (targets.length === 0) {
    return { totalTargets: 0, fetched: 0, skipped: 0, failed: 0, removedStale: 0 };
  }

  let cached: Record<string, CachedEntry> = {};
  try {
    cached = await listCachedEntries(eventId);
  } catch {
    cached = {};
  }

  // 1) Drop cached files that are no longer in this event's setlist
  //    (item removed, or its song unlinked) so the device doesn't keep junk —
  //    but NEVER one we couldn't get back. A null cached path means LOCAL-ONLY
  //    bytes: a file picked off this machine's disk whose R2 upload failed, kept
  //    by live-mode's "ไฟล์ยังเล่นได้เฉพาะเครื่องนี้" fallback. There is no online
  //    copy to re-download, so deleting it here would leave that row silent after
  //    the next restart — and nothing on screen would say so, because the current
  //    session keeps playing off its live object URL. Local-only leftovers are
  //    cleared deliberately from "พื้นที่ในเครื่อง", never by เตรียมเพลง. That holds
  //    even when such a record looks suspect: a dangling reference is still the only
  //    trace of that file, and there is nothing here to replace it with.
  const wanted = new Set(targets.map((t) => t.itemId));
  let removedStale = 0;
  for (const [itemId, entry] of Object.entries(cached)) {
    if (wanted.has(itemId) || entry.path == null) continue;
    try {
      await deleteAudio(eventId, itemId);
      removedStale++;
    } catch {
      /* ignore */
    }
  }

  // 2) Anything whose cached version differs from the current path needs a
  //    (re)download — and so does a SUSPECT record, i.e. one holding the picked
  //    File instead of a copy of the bytes (see CachedEntry.suspect): its path may
  //    match perfectly while the file it points at is long gone. Re-pull real bytes
  //    now, while the venue still has a network. saveAudio writes the same key, so
  //    the newer file replaces the stale blob — old version gone, latest wins.
  const need = targets.filter((t) => {
    const entry = cached[t.itemId];
    return !entry || entry.path !== t.path || entry.suspect;
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
      // Read-through the SHARED path-keyed cache (lib/song-cache.ts) before hitting
      // R2: the same master recurs across every event that plays it, so a device
      // preparing several upcoming shows of one band must not re-download (and
      // re-store) the same file once per event. A miss here downloads once and
      // write-throughs the shared cache for the next event's เตรียมเพลง to hit.
      //
      // A hit can still be a picked File rather than copied bytes — song-cache.ts's
      // write side now copies on the way in, but records written before that fix
      // (or from a source that couldn't be read at write time) may still hold a
      // bare reference. That mints an object URL fine but plays silence once the
      // source is moved/unplugged, and this readiness check is exactly the thing
      // supposed to catch that before showtime — so a File here is a miss, not a hit.
      const shared = await getCachedSongBlob(t.path);
      const trustedShared = shared && !(shared instanceof File) ? shared : null;
      const blob = trustedShared ?? (await downloadEventAudio(t.path, { signal }));
      if (isCancelled?.()) break;
      if (!trustedShared) cacheSongBlob(t.path, blob).catch(() => {}); // best-effort; never fail the prepare over this
      await saveAudio(eventId, t.itemId, blob, t.name, t.path);
      fetched++;
    } catch {
      // A cancel aborts the in-flight download: that's the operator stopping, not
      // a failed file, and there's nothing left to try — leave without counting it.
      if (isCancelled?.() || signal?.aborted) break;
      failed++;
    }
    onProgress?.({ total, done: fetched, failed, currentName: t.name });
  }

  return { totalTargets: targets.length, fetched, skipped, failed, removedStale };
}
