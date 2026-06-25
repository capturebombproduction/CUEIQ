// Band-wide, library-centric audio cache (IndexedDB), keyed by the R2 object
// PATH (which carries a version suffix, so a replaced file is a new key).
//
// This is the shared on-device store that makes BOTH Practice Mode and Live Mode
// play instantly. It fills ON DEMAND — a song is cached the first time it's played
// (getSongBlob), and a show's songs are cached up-front only when the operator
// explicitly prepares the device (PrepareDeviceButton / ShowReadinessCheck). There
// is no auto-download on app open: nothing is pulled until the user asks for it.
//
// Distinct from lib/audio-store.ts, which keys by `${eventId}::${itemId}` for
// Live Mode's per-show offline restore. This one is keyed by path so any consumer
// that knows a song's audio_path finds the bytes — no event needed.

import { downloadEventAudio } from "./audio-remote";

const DB_NAME = "cueiq-songs";
const STORE = "blobs";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface SongRecord {
  blob: Blob;
  name: string | null;
  cachedAt: number;
}

/** Cached bytes for a path, or null if we don't hold them. Never downloads. */
export async function getCachedSongBlob(path: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(path);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SongRecord | undefined)?.blob ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null; // IndexedDB unavailable → behave as a cache miss
  }
}

export async function cacheSongBlob(
  path: string,
  blob: Blob,
  name?: string | null
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rec: SongRecord = { blob, name: name ?? null, cachedAt: Date.now() };
    tx.objectStore(STORE).put(rec, path);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * The bytes for a path: from cache if present, otherwise download once (via the
 * same R2 presigned GET as everywhere else) and cache for next time. This is what
 * the practice player calls instead of downloadEventAudio, so a prefetched song
 * opens instantly and an un-prefetched one still works (and is cached after).
 */
export async function getSongBlob(path: string): Promise<Blob> {
  const hit = await getCachedSongBlob(path);
  if (hit) return hit;
  const blob = await downloadEventAudio(path);
  cacheSongBlob(path, blob).catch(() => {}); // best-effort; don't block playback
  return blob;
}

/** Set of paths currently held, so the prefetcher can skip what's already cached. */
export async function listCachedSongPaths(): Promise<Set<string>> {
  try {
    const db = await openDB();
    return await new Promise<Set<string>>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => {
        db.close();
        resolve(new Set((req.result as IDBValidKey[]).map(String)));
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return new Set();
  }
}

export interface SongCacheSummary {
  totalBytes: number;
  count: number;
}

/** Total size + count of the on-device library cache (Blob.size is metadata). */
export async function getSongCacheSummary(): Promise<SongCacheSummary> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    const out: SongCacheSummary = { totalBytes: 0, count: 0 };
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const rec = cursor.value as SongRecord;
        out.totalBytes += rec.blob?.size ?? 0;
        out.count += 1;
        cursor.continue();
      } else {
        db.close();
        resolve(out);
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/** The library songId encoded in an object path
 *  (<tenant>/<group>/songs/<songId>-<rand>.<ext>), or null if it doesn't match.
 *  buildSongAudioPath always produces this shape, so song-cache keys parse cleanly. */
function songIdFromPath(path: string): string | null {
  const seg = path.split("/").pop() ?? "";
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i.exec(seg);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Drop cached blobs that are SUPERSEDED versions of songs we currently know:
 * same songId, but a different (older) path than the song's current audio_path —
 * i.e. the file was replaced (the random suffix changed), orphaning the old blob.
 *
 * Safe by construction: a cached path whose songId isn't in `currentBySong`
 * (e.g. a band the caller didn't enumerate) is KEPT, so this never deletes a file
 * that might still be in use — it only removes provably-stale versions. Returns
 * how many it removed. Best-effort: resolves 0 if IndexedDB is unavailable.
 */
export async function pruneSupersededSongs(
  currentBySong: Map<string, string>
): Promise<number> {
  if (currentBySong.size === 0) return 0;
  let db: IDBDatabase;
  try {
    db = await openDB();
  } catch {
    return 0;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let removed = 0;
    store.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        const path = String(cursor.key);
        const sid = songIdFromPath(path);
        const current = sid ? currentBySong.get(sid) : undefined;
        if (current && current !== path) {
          cursor.delete();
          removed++;
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(removed);
    };
    tx.onerror = () => {
      db.close();
      resolve(removed);
    };
  });
}

/** Wipe the whole library cache (Practice/Live re-download or re-prefetch later). */
export async function clearSongCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
