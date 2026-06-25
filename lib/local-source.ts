// Per-DEVICE local audio source overrides, keyed by library songId (IndexedDB).
//
// This is what lets ONE desktop machine play a song from a file that lives on
// THAT machine instead of the online R2 master — the per-device source toggle
// behind the "ใช้ไฟล์ในเครื่องนี้" control in the Library (desktop-only UI).
//
// It is deliberately distinct from the two existing audio stores:
//   • lib/song-cache.ts  — a CACHE of the ONLINE R2 master, keyed by object PATH
//     (a replaced file gets a new path → the cache invalidates itself).
//   • lib/audio-store.ts — Live Mode's per-show offline restore, keyed by
//     `${eventId}::${itemId}`.
// A local source is neither a cache nor a show snapshot: it's a chosen override
// that NEVER syncs and is NEVER uploaded on its own. Making it the master is an
// explicit, separate action ("ดันขึ้นเป็นต้นฉบับ" → the Library's R2 upload path).
//
// Playback (practice-player + live-mode) reads getLocalSource(songId) FIRST and
// only falls back to the R2 master when there's no override — so this swaps the
// audio SOURCE without touching the transport/position logic on either path. The
// reads are defensive (any failure resolves to null → fall back to the master).

const DB_NAME = "cueiq-local-source";
const STORE = "sources";

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

interface LocalSourceRecord {
  blob: Blob;
  name: string;
  setAt: number;
}

/**
 * The local file chosen for a song on THIS device, or null if none (or on any
 * error). Sits on the playback hot path, so it never throws — a miss just falls
 * back to the online master.
 */
export async function getLocalSource(
  songId: string | null | undefined
): Promise<{ blob: Blob; name: string } | null> {
  if (!songId) return null;
  try {
    const db = await openDB();
    return await new Promise<{ blob: Blob; name: string } | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(songId);
      req.onsuccess = () => {
        db.close();
        const rec = req.result as LocalSourceRecord | undefined;
        resolve(rec ? { blob: rec.blob, name: rec.name } : null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null; // IndexedDB unavailable → behave as "no override"
  }
}

/** Set (or replace) the local source for a song on this device. */
export async function setLocalSource(
  songId: string,
  blob: Blob,
  name: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rec: LocalSourceRecord = { blob, name, setAt: Date.now() };
    tx.objectStore(STORE).put(rec, songId);
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

/** Drop the local override for a song → playback reverts to the R2 master. */
export async function clearLocalSource(songId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(songId);
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

/** Set of songIds that currently have a local override on this device (for the
 *  Library to badge rows). Best-effort: empty set if IndexedDB is unavailable. */
export async function listLocalSourceIds(): Promise<Set<string>> {
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
