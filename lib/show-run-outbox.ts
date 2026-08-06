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
import { settleOnAbort } from "@/lib/idb-tx";
import { wroteNothing } from "@/lib/write-guard";
import { hasLiveSession } from "@/lib/auth-session";

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
    // ⚠️ VERSION 2, and it must stay in lock-step with lib/run-order-outbox.ts,
    // which shares this database. Opening an existing v2 database at version 1
    // throws VersionError — so the moment that file bumped the version, an
    // unchanged open(…, 1) here would have failed EVERY offline last-run write on
    // any machine that had already touched the running-order queue. Both files
    // create BOTH stores for the same reason: a fresh install opens straight at
    // the highest version and runs onupgradeneeded exactly once.
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains("runseq")) db.createObjectStore("runseq");
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
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
    settleOnAbort(tx, () => {
      db.close();
      reject(tx.error);
    });
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
    // Awaited between two ops of the flush loop — a hang would stall the replay
    // with the show's own last-run time still queued.
    settleOnAbort(tx, () => {
      db.close();
      resolve();
    });
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

/** Thrown by apply() specifically for the "matched no row" case, so flushOutbox
 *  can tell it apart from a network/server error without string-sniffing. */
class WroteNothingError extends Error {
  constructor() {
    super("write matched no row (not signed in, or the event is gone)");
  }
}

async function apply(op: ShowRunOp): Promise<void> {
  const supabase = createClient();
  if (op.kind === "event_last_run") {
    const { data, error } = await supabase
      .from("events")
      .update({
        last_run_seconds: op.seconds,
        last_run_at: op.at != null ? new Date(op.at).toISOString() : null,
      })
      .eq("id", op.eventId)
      .select("id");
    if (error) throw error;
    // ⚠️ The .select() is load-bearing, not decoration. Without it a replay sent
    // as ANON — an expired token whose refresh failed, which is the normal state
    // in the first minute after a venue reconnect — comes back 204 / error:null,
    // flushOutbox reads that as success, and removeOp() DESTROYS the only copy of
    // an offline show's run time. The live snapshot is long gone by then, so the
    // number the operator watched all night is simply unrecoverable. Throwing
    // leaves the op queued for the next attempt, which is what it was queued for.
    if (wroteNothing(data)) throw new WroteNothingError();
  }
}

/**
 * Bridge to the desktop-only management outbox, published on `window` by
 * desktop/src/data/event-bundle.ts. This file is shared with the web build (see
 * the "@/lib/supabase/client" note at the top), which never registers the
 * bridge — same reason components/event/events-list.tsx reaches the read-cache
 * this way instead of importing "~/data/*" directly. Undefined in a browser is
 * also the CORRECT answer there, not just a safe fallback: the web has no
 * offline event.create (saveEventWrite only queues on desktop), so a web
 * eventId can never be "the server doesn't have it yet, but a device does".
 */
type EventCacheBridge = { hasPendingOp?: (eventId: string) => Promise<boolean> };
function pendingMgmtOpBridge(): EventCacheBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { cueiqEventCache?: EventCacheBridge }).cueiqEventCache;
}

/** True only when the events row is demonstrably gone — a probe error (still
 *  offline, RLS hiccup, whatever) is "couldn't tell", not "it's gone", so it
 *  answers false and the op stays queued rather than being dropped on a guess.
 *  Same for an event that hasn't been created on the server YET: the desktop
 *  lets a whole show run on an event that exists only as a queued offline
 *  `event.create` (see the bridge above) — "no such row" there means "not
 *  created yet", never "deleted", and must not cost the night's run time. */
async function eventIsGone(eventId: string): Promise<boolean> {
  try {
    const bridge = pendingMgmtOpBridge();
    if (bridge?.hasPendingOp && (await bridge.hasPendingOp(eventId))) return false;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("events")
      .select("id")
      .eq("id", eventId)
      .maybeSingle();
    if (error) return false;
    return !data;
  } catch {
    return false;
  }
}

/**
 * Replay every queued op. Each op is keyed by (kind, eventId), so ops are
 * independent of each other — a failure on one event's last-run write carries
 * no information about any other event's. So a failure is skipped, not fatal:
 * the loop moves on and gives every other queued event its own chance, instead
 * of one bad op at the front of the list jamming everything behind it.
 *
 * "Failure" itself splits two ways once a write matches no row (see
 * write-guard.ts): with no live session it's the anon-fallback case — purely
 * transient, leave it queued. With a live session it can mean the event row
 * was deleted (another admin removed the show, or this is a stale tab) — an
 * UPDATE can never resurrect a deleted row, so that op would fail identically
 * forever. Probing for that and dropping it is what keeps a single permanently
 * unmatchable op from sitting in the queue until the end of time.
 *
 * Returns counts. Safe to call repeatedly (idempotent: each op overwrites the
 * same field).
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
    } catch (err) {
      if (err instanceof WroteNothingError && (await hasLiveSession())) {
        if (await eventIsGone(rec.op.eventId)) {
          await removeOp(key); // dropped, not flushed — nothing left to retry
          continue;
        }
      }
      // still offline / server error / row exists but write was refused — leave
      // this one queued and let the rest of the events still get their turn.
      continue;
    }
  }
  const remaining = (await listOps()).length;
  return { flushed, remaining };
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
    const { data, error } = await supabase
      .from("events")
      .update({
        last_run_seconds: seconds,
        last_run_at: at != null ? new Date(at).toISOString() : null,
      })
      .eq("id", eventId)
      .select("id");
    // Same anon-fallback hole as apply() above: a 204/error:null with no row
    // touched must NOT be read as success, or จบโชว์ reports a save that never
    // happened and nothing is queued to retry it. Fall through to enqueue().
    if (!error && !wroteNothing(data)) return;
  } catch {
    /* network failure → fall through to queue */
  }
  await enqueue({ kind: "event_last_run", eventId, seconds, at }).catch(() => {});
}
