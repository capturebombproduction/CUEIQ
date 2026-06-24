// Local snapshot of an event's "show data" — everything Live Mode needs to RUN a
// show without the network (event meta + setlist + the song→audio map + the
// viewer's edit permission), kept in IndexedDB and keyed by eventId. This is the
// DATA counterpart to the audio caches (lib/song-cache.ts / lib/audio-store.ts):
// those hold the bytes, this holds the running order.
//
// Written whenever the device sees fresh server data (a live-page load); read as
// the local-first source when a show is opened OFFLINE and the server can't render
// (the cold-boot shell at app/live-shell). See docs/offline-first-plan.md P1.
//
// Distinct DB from the audio stores so clearing one never disturbs the other.

import type { SetlistItem } from "./types";
import type { SongAudioMap } from "./audio-targets";

const DB_NAME = "cueiq-events";
const STORE = "bundles";
const VERSION = 1;

/** Exactly the props LiveMode is mounted with, so an offline boot can reconstruct
 *  the show from this alone. */
export interface EventSnapshot {
  eventId: string;
  groupId: string;
  eventName: string;
  items: SetlistItem[];
  songAudio: SongAudioMap;
  canEdit: boolean;
  lastRunSeconds: number | null;
  lastRunAt: string | null;
  savedAt: number; // Date.now() when this snapshot was written
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist (or overwrite) the show data for an event. Best-effort: a failure just
 *  means this device can't cold-boot the show offline — the online path is
 *  unaffected — so callers fire-and-forget. */
export async function saveEventSnapshot(
  snap: Omit<EventSnapshot, "savedAt">
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rec: EventSnapshot = { ...snap, savedAt: Date.now() };
    tx.objectStore(STORE).put(rec, snap.eventId);
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

/** The locally-saved show data for an event, or null if none / IndexedDB is
 *  unavailable. Never throws — a cold-boot caller treats null as "not prepared". */
export async function getEventSnapshot(
  eventId: string
): Promise<EventSnapshot | null> {
  try {
    const db = await openDB();
    return await new Promise<EventSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(eventId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as EventSnapshot | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

/** Event ids that have a saved snapshot (for housekeeping / readiness display). */
export async function listEventSnapshotIds(): Promise<string[]> {
  try {
    const db = await openDB();
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as IDBValidKey[]).map(String));
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

/** Drop one event's saved show data. */
export async function deleteEventSnapshot(eventId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(eventId);
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

/** Wipe every saved show data snapshot. */
export async function clearEventSnapshots(): Promise<void> {
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
