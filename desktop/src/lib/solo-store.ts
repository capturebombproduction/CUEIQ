// On-device store for MY SHOW (โหมดโชว์เดี่ยว) — the fully-local standalone show.
//
// By design (พี่'s call, 2026-07-02): NO login, NO cloud, NO network. Everything —
// the audio bytes, the running order, the timings, the saved last-run — lives in
// THIS machine's IndexedDB and never leaves it. That makes the mode usable on a
// brand-new machine, keeps other people's songs out of sight, and means nothing
// on a server can break a show. It is deliberately a separate silo from the
// event/library stores (song-cache, audio-store): those mirror CLOUD state; this
// IS the state.

import { settleOnAbort } from "@/lib/idb-tx";

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
  /** "เข้าหลังเพลงก่อนหน้า" (TIMING_LABEL), signed, against the row ABOVE - a show's
   *  buffer_before_seconds: -5 = comes in 5 s before it ends (Auto: over its last
   *  seconds), 3 = waits 3 s after it ends, 0 = straight after. The first row's counts
   *  for nothing. */
  timingSeconds: number;
  /** Legacy (บัฟเฟอร์ - time after this row): folded into the next row's timingSeconds
   *  on read (foldSoloTimings) and 0 from then on. */
  bufferAfterSeconds?: number;
  /** Legacy (สวน - this song's lead over the row above): folded the same way. */
  overlapLeadSeconds?: number;
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

/**
 * The old two fields as the one "เข้าหลังเพลงก่อนหน้า" (พี่ 2026-10-23: "รวมช่องบัฟเฟอร์/สวน
 * ... ช่องเดียวแบบ setlist"), the way 0049 folded a show's buffer_after into the next
 * row's buffer_before: a row's บัฟเฟอร์ becomes the next row's wait, less that row's สวน
 * (wait 15 then a 5 s lead = 10). A lead only ever counted on a song, and never on the
 * first row; a last row's บัฟเฟอร์ has no row after it and is dropped, as 0049 did. The
 * run times come out the same, the last row's tail aside. Already folded rows (both old
 * fields 0) come back as they are, so this runs on every read.
 */
export function foldSoloTimings(sorted: SoloItem[]): SoloItem[] {
  return sorted.map((row, i) => {
    const carried = i > 0 ? Math.max(0, sorted[i - 1].bufferAfterSeconds || 0) : 0;
    const lead = i > 0 && row.kind === "song" ? Math.max(0, row.overlapLeadSeconds || 0) : 0;
    return {
      ...row,
      timingSeconds: Math.round((row.timingSeconds ?? 0) + carried - lead),
      bufferAfterSeconds: 0,
      overlapLeadSeconds: 0,
    };
  });
}

/** A stored row the fold changed - written back once, so the next launch reads it as is. */
const foldedAway = (stored: SoloItem, row: SoloItem) =>
  !!stored.bufferAfterSeconds ||
  !!stored.overlapLeadSeconds ||
  (stored.timingSeconds ?? 0) !== row.timingSeconds;

export async function listSoloItems(): Promise<SoloItem[]> {
  let stored: SoloItem[];
  try {
    const db = await openDB();
    stored = await new Promise<SoloItem[]>((resolve, reject) => {
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
      settleOnAbort(tx, () => {
        db.close();
        reject(tx.error);
      });
    });
  } catch {
    return [];
  }
  const rows = foldSoloTimings(stored);
  const changed = rows.filter((row, i) => foldedAway(stored[i], row));
  // Best-effort: a write that fails leaves the old fields, and the next read folds
  // them again to the same numbers.
  if (changed.length > 0) await putSoloItems(changed).catch(() => {});
  return rows;
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
    // This record carries the audio itself — out of room is a real outcome, and
    // the picker's "เพิ่มเพลงไม่สำเร็จ" path is already waiting for it.
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
      settleOnAbort(tx, () => {
        db.close();
        reject(tx.error);
      });
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
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
