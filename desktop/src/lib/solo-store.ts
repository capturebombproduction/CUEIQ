// On-device store for MY SHOW (โหมดโชว์เดี่ยว) — the fully-local standalone show.
//
// By design (พี่'s call, 2026-07-02): NO login, NO cloud, NO network. Everything —
// the audio bytes, the running order, the timings, the saved last-run — lives in
// THIS machine's IndexedDB and never leaves it. That makes the mode usable on a
// brand-new machine, keeps other people's songs out of sight, and means nothing
// on a server can break a show. It is deliberately a separate silo from the
// event/library stores (song-cache, audio-store): those mirror CLOUD state; this
// IS the state.

const DB_NAME = "cueiq-solo";
const ITEMS = "items";
const META = "meta";

export interface SoloItem {
  id: string;
  kind: "song" | "break"; // break = MC/พัก — countdown only, no audio
  title: string;
  fileName: string | null;
  blob: Blob | null;
  /** Countdown length of this slot (auto-detected from the file for songs; editable). */
  durationSeconds: number;
  /** Extra time appended after the song (talk/changeover) before the slot ends. */
  bufferAfterSeconds: number;
  loop: boolean;
  volume: number; // 0–100 preset for this track
  sortOrder: number;
}

export interface SoloLastRun {
  seconds: number;
  at: number; // epoch ms
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listSoloItems(): Promise<SoloItem[]> {
  try {
    const db = await openDB();
    return await new Promise<SoloItem[]>((resolve, reject) => {
      const tx = db.transaction(ITEMS, "readonly");
      const req = tx.objectStore(ITEMS).getAll();
      req.onsuccess = () => {
        db.close();
        const rows = (req.result as SoloItem[]) ?? [];
        resolve(rows.sort((a, b) => a.sortOrder - b.sortOrder));
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

export async function putSoloItem(item: SoloItem): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ITEMS, "readwrite");
    tx.objectStore(ITEMS).put(item, item.id);
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

/** Persist several items in one transaction (reorder writes every moved row). */
export async function putSoloItems(items: SoloItem[]): Promise<void> {
  if (items.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ITEMS, "readwrite");
    const store = tx.objectStore(ITEMS);
    items.forEach((it) => store.put(it, it.id));
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

export async function deleteSoloItem(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ITEMS, "readwrite");
    tx.objectStore(ITEMS).delete(id);
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

export async function getSoloLastRun(): Promise<SoloLastRun | null> {
  try {
    const db = await openDB();
    return await new Promise<SoloLastRun | null>((resolve, reject) => {
      const tx = db.transaction(META, "readonly");
      const req = tx.objectStore(META).get("lastRun");
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SoloLastRun | undefined) ?? null);
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

export async function setSoloLastRun(rec: SoloLastRun | null): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, "readwrite");
    if (rec) tx.objectStore(META).put(rec, "lastRun");
    else tx.objectStore(META).delete("lastRun");
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

/** Total bytes of stored audio (Blob.size is metadata — cheap). */
export async function soloStorageBytes(): Promise<number> {
  try {
    const items = await listSoloItems();
    return items.reduce((s, it) => s + (it.blob?.size ?? 0), 0);
  } catch {
    return 0;
  }
}
