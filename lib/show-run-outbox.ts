// Durable queue for show-run writes that fail OFFLINE, replayed when the network
// returns — the "sync after reconnect" half of offline-first for the on-stage data
// an operator produces (today: the saved last-run time). A write tried while online
// succeeds immediately and is never queued; only a failure (offline) enqueues.
//
// Show-run is the "offline / main wins" conflict zone (docs/offline-first-plan.md
// §5), so a queued write replays as-is and overwrites the server copy on reconnect.
// Keyed per (kind, eventId) so re-queuing the same datum just updates the pending
// value instead of stacking duplicates (last value wins — correct for last-run).

// Absolute path so the desktop build's "@/lib/supabase/client" alias applies
// (see lib/show-authority.ts for why a relative import would break under file://).
import { createClient } from "@/lib/supabase/client";

const DB_NAME = "cueiq-outbox";
const STORE = "ops";

export type ShowRunOp = {
  kind: "event_last_run";
  eventId: string;
  seconds: number | null;
  at: number | null; // epoch ms, or null to clear
};

interface QueuedOp {
  op: ShowRunOp;
  queuedAt: number;
}

function opKey(op: ShowRunOp): string {
  return `${op.kind}:${op.eventId}`;
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Queue an op (replacing any pending op for the same datum). Best-effort. */
export async function enqueue(op: ShowRunOp): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rec: QueuedOp = { op, queuedAt: Date.now() };
    tx.objectStore(STORE).put(rec, opKey(op));
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

async function listOps(): Promise<{ key: string; rec: QueuedOp }[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const out: { key: string; rec: QueuedOp }[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ key: String(cursor.key), rec: cursor.value as QueuedOp });
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

async function removeOp(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

/** How many writes are waiting to sync (for a "ค้าง N รายการ" status chip). */
export async function pendingCount(): Promise<number> {
  try {
    const ops = await listOps();
    return ops.length;
  } catch {
    return 0;
  }
}

async function apply(op: ShowRunOp): Promise<void> {
  const supabase = createClient();
  if (op.kind === "event_last_run") {
    const { error } = await supabase
      .from("events")
      .update({
        last_run_seconds: op.seconds,
        last_run_at: op.at != null ? new Date(op.at).toISOString() : null,
      })
      .eq("id", op.eventId);
    if (error) throw error;
  }
}

/**
 * Replay every queued op. Stops at the first failure (still offline / server
 * error) and leaves the rest queued for the next attempt. Returns counts. Safe to
 * call repeatedly (idempotent: each op overwrites the same field).
 */
export async function flushOutbox(): Promise<{ flushed: number; remaining: number }> {
  let ops: { key: string; rec: QueuedOp }[];
  try {
    ops = await listOps();
  } catch {
    return { flushed: 0, remaining: 0 };
  }
  let flushed = 0;
  for (const { key, rec } of ops) {
    try {
      await apply(rec.op);
      await removeOp(key);
      flushed++;
    } catch {
      break; // network/server still failing — try again later
    }
  }
  return { flushed, remaining: ops.length - flushed };
}

/**
 * Write the saved last-run time for an event, queuing it for later if offline.
 * Used by Live Mode's จบโชว์ / ล้าง so the run time survives a fully-offline show
 * and lands on the server when the device reconnects.
 */
export async function persistLastRun(
  eventId: string,
  seconds: number | null,
  at: number | null
): Promise<void> {
  try {
    const supabase = createClient();
    const { error } = await supabase
      .from("events")
      .update({
        last_run_seconds: seconds,
        last_run_at: at != null ? new Date(at).toISOString() : null,
      })
      .eq("id", eventId);
    if (!error) return;
  } catch {
    /* network failure → fall through to queue */
  }
  await enqueue({ kind: "event_last_run", eventId, seconds, at }).catch(() => {});
}
