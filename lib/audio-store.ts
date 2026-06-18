// Persist Live Mode audio files on-device with IndexedDB so they survive a page
// refresh / app reopen. Files are NOT uploaded anywhere — they stay in the browser.

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
  name: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ blob, name }, keyFor(eventId, itemId));
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

export interface SavedAudio {
  itemId: string;
  blob: Blob;
  name: string;
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
          const val = cursor.value as { blob: Blob; name: string };
          results.push({
            itemId: k.slice(prefix.length),
            blob: val.blob,
            name: val.name,
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
