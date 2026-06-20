// Local cache for Live Mode audio files (IndexedDB) so they survive a page
// refresh / app reopen and a device need not re-download from Storage every time.
// The authoritative copy now lives ONLINE in Supabase Storage (see lib/audio-remote.ts);
// each cached record also stores the object `path` so a replaced file (new path)
// invalidates the stale cache.

const DB_NAME = "cueiq-audio";
const STORE = "files";
const SEP = "::";

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

function keyFor(eventId: string, itemId: string) {
  return `${eventId}${SEP}${itemId}`;
}

export async function saveAudio(
  eventId: string,
  itemId: string,
  blob: Blob,
  name: string,
  path?: string | null
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ blob, name, path: path ?? null }, keyFor(eventId, itemId));
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

export async function deleteAudio(eventId: string, itemId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(keyFor(eventId, itemId));
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
 * Map of itemId → cached object path for one event, WITHOUT loading the blobs.
 * Used to compare what the device holds against the event's current files
 * (readiness + version checks) cheaply. Missing key = not cached; null value =
 * a legacy local-only file with no known online version.
 */
export async function listCachedItemPaths(
  eventId: string
): Promise<Record<string, string | null>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const prefix = `${eventId}${SEP}`;
    const out: Record<string, string | null> = {};
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const k = String(cursor.key);
        if (k.startsWith(prefix)) {
          const val = cursor.value as { path?: string | null };
          out[k.slice(prefix.length)] = val.path ?? null;
        }
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

export interface CacheSummary {
  totalBytes: number;
  fileCount: number;
  byEvent: Record<string, { bytes: number; count: number }>;
}

/** Total size + per-event breakdown of the on-device audio cache (Blob.size is
 * metadata, so this doesn't load the bytes). Lets the UI show how much space the
 * cached shows use and clear old ones. */
export async function getCacheSummary(): Promise<CacheSummary> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    const summary: CacheSummary = { totalBytes: 0, fileCount: 0, byEvent: {} };
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const eventId = String(cursor.key).split(SEP)[0];
        const val = cursor.value as { blob?: Blob };
        const bytes = val.blob?.size ?? 0;
        summary.totalBytes += bytes;
        summary.fileCount += 1;
        const e = (summary.byEvent[eventId] ??= { bytes: 0, count: 0 });
        e.bytes += bytes;
        e.count += 1;
        cursor.continue();
      } else {
        db.close();
        resolve(summary);
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/** Delete every cached file for an event (all `${eventId}::*` keys). */
export async function clearEventAudio(eventId: string): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const prefix = `${eventId}${SEP}`;
    let removed = 0;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (String(cursor.key).startsWith(prefix)) {
          cursor.delete();
          removed += 1;
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
      reject(tx.error);
    };
  });
}

/** Wipe the whole on-device audio cache. */
export async function clearAllAudio(): Promise<void> {
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

export interface SavedAudio {
  itemId: string;
  blob: Blob;
  name: string;
  path: string | null; // Storage object path this cached blob came from (null = local-only legacy)
}

export async function loadAudioForEvent(eventId: string): Promise<SavedAudio[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const prefix = `${eventId}${SEP}`;
    const results: SavedAudio[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const k = String(cursor.key);
        if (k.startsWith(prefix)) {
          const val = cursor.value as { blob: Blob; name: string; path?: string | null };
          results.push({
            itemId: k.slice(prefix.length),
            blob: val.blob,
            name: val.name,
            path: val.path ?? null,
          });
        }
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}
