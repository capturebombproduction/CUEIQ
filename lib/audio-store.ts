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
