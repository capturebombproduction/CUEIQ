// Offline queue for the FESTIVAL running-order board (run_sequence).
//
// The board is the one screen a whole festival reads: who is on stage, who is
// next, how late the day is running. Round 7 gave the desktop the ability to READ
// it with no network; driving it still required one. So at a venue with dead wifi
// the show-caller could see the order and not move it — and a running order that
// cannot be moved is a running order nobody is keeping.
//
// WHY THIS IS SAFE TO REPLAY, AND WHY IT NEEDED NO NEW CONFLICT RULE.
// Every press on that board is already a compare-and-swap: EventLiveCaller writes
// `{ id, partial, expect }` and treats a 0-row result as "someone else got there
// first" (see its apply()). That precondition is exactly what makes an offline
// press replayable: it carries the server state it branched from, so on reconnect
// the server can still tell "nobody moved" from "the board moved on". Online
// behaviour is unchanged; offline just defers the same write.
//
// ⚠️ THE MERGE RULE IS THE WHOLE TRICK. Presses accumulate per ROW, and the
// preconditions of every press after the first describe state THIS DEVICE created
// locally — state the server has never seen. Replaying those would deadlock the
// row forever. So a merged op keeps the FIRST expect (the last server truth we
// actually observed) and the LATEST value of each column. Rows are independent, so
// no ordering between them is needed.
//
// A precondition that no longer holds is PARKED, not clobbered and not dropped —
// the same answer the management outbox and the audio-upload queue give. Two
// people calling the same show is a thing a human has to look at, not something to
// resolve by overwriting one of them.
import { createClient } from "@/lib/supabase/client";
import { settleOnAbort } from "@/lib/idb-tx";

/** Fired after any queue change so chips/panels can re-read (mirrors MGMT_OUTBOX_EVENT). */
export const RUNSEQ_OUTBOX_EVENT = "cueiq:runseq-outbox-change";

/** Toast copy for a caller press that was kept locally instead of lost. */
export const RUNSEQ_QUEUED_MESSAGE =
  "ออฟไลน์อยู่ — คิวบนเครื่องนี้เดินต่อแล้ว จะซิงค์ให้เมื่อเน็ตกลับ";

/** The only columns the show-caller ever writes. Nothing else may ride this queue —
 *  the builder owns titles, order and the plan, and must not be replayed over. */
export interface RunSeqPatch {
  status?: string;
  actual_start?: string | null;
  actual_end?: string | null;
  offset_min?: number | null;
  buffer_seconds?: number;
}

export interface RunSeqOp {
  /** run_sequence.id */
  rowId: string;
  /** Which board this row belongs to — display only, so a parked op can be named. */
  festival: string;
  /** Columns to write. */
  patch: RunSeqPatch;
  /** Values that must STILL hold on the server. Empty = write unconditionally. */
  expect: RunSeqPatch;
  /** Human label for the chip / conflict list, e.g. "เริ่ม: วง Seishin Kakumei". */
  label: string;
  queuedAt: number;
  /** Set once a replay found the server had moved on. Keeps it out of later flushes. */
  conflict?: boolean;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * This is not tidiness. `undefined` and `null` are different facts here and the
 * flush cannot tell them apart on its own: it walks `expect` with
 * `v == null ? q.is(k, null) : q.eq(k, v)`, so a key that merely wasn't specified
 * would be replayed as "this column must currently BE NULL" — a precondition
 * nobody intended, failing forever and parking the row as a false conflict. In
 * `patch` it is just as bad in the other direction: supabase-js drops undefined
 * when it serialises, so the column silently isn't written at all.
 *
 * Applied inside enqueue so no call site can get it wrong. A real `null` (clearing
 * offset_min) is kept — that IS a value.
 */
export function compactPatch(p: RunSeqPatch): RunSeqPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined) out[k] = v;
  }
  return out as RunSeqPatch;
}

/**
 * Fold a new press into whatever is already queued for that row.
 *
 * Keeps the FIRST expect on purpose — see the header. `prev` undefined = this is
 * the first press for the row, so the op is taken as-is.
 */
export function mergeOp(prev: RunSeqOp | undefined, next: RunSeqOp): RunSeqOp {
  if (!prev) return next;
  return {
    ...next,
    // the label + timestamp of the LATEST press describe where the row now is
    patch: { ...prev.patch, ...next.patch },
    // ...but the precondition must still describe the last SERVER state we saw
    expect: prev.expect,
    queuedAt: prev.queuedAt,
    // a row that already parked stays parked until a human clears it
    conflict: prev.conflict,
  };
}

/**
 * What to do with one replayed op, given what the server said.
 *
 * `rows` = the number of rows the conditional UPDATE actually matched, and
 * `stillExists` = whether the row is there at all when it matched none.
 *
 *  • "done"    — it landed.
 *  • "dropped" — the row is gone (the builder deleted it while we were offline).
 *                An update can't resurrect a row, and re-queueing forever is worse
 *                than admitting the slot no longer exists.
 *  • "conflict"— the row is there but no longer holds what we branched from:
 *                someone else drove the board. Park it for a human.
 */
export function classifyReplay(
  rows: number,
  stillExists: boolean
): "done" | "dropped" | "conflict" {
  if (rows > 0) return "done";
  return stillExists ? "conflict" : "dropped";
}

// ---------------------------------------------------------------------------
// Durable storage — same DB as the show-run outbox, its own store.
// ---------------------------------------------------------------------------
const DB_NAME = "cueiq-outbox";
const STORE = "runseq";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    // v2 adds this store beside the show-run outbox's "ops" store. onupgradeneeded
    // must create BOTH, because a fresh install opens straight at v2 and would
    // otherwise leave "ops" missing.
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("ops")) db.createObjectStore("ops");
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function announce(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RUNSEQ_OUTBOX_EVENT));
  }
}

/** Queue (or fold into) the pending op for this row. Best-effort — a storage
 *  failure must never break the press the operator just made on stage. */
export async function enqueueRunSeq(raw: RunSeqOp): Promise<void> {
  const op: RunSeqOp = {
    ...raw,
    patch: compactPatch(raw.patch),
    expect: compactPatch(raw.expect),
  };
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(op.rowId);
      get.onsuccess = () => {
        store.put(mergeOp(get.result as RunSeqOp | undefined, op), op.rowId);
      };
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
    announce();
  } catch {
    /* best-effort: the board still shows the operator's press */
  }
}

export async function listRunSeqOps(): Promise<RunSeqOp[]> {
  try {
    const db = await openDB();
    return await new Promise<RunSeqOp[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as RunSeqOp[]);
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.oncomplete = () => db.close();
      settleOnAbort(tx, () => {
        db.close();
        reject(tx.error);
      });
    });
  } catch {
    return [];
  }
}

async function removeRunSeq(rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      rowIds.forEach((id) => store.delete(id));
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
  } catch {
    /* it will simply be retried on the next flush */
  }
}

/** Mark ops as parked so a later flush leaves them alone until a human decides. */
async function parkRunSeq(ops: RunSeqOp[]): Promise<void> {
  if (ops.length === 0) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      ops.forEach((o) => store.put({ ...o, conflict: true }, o.rowId));
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
  } catch {
    /* retried next flush */
  }
}

/** Throw away a parked op — the operator has looked at the board and accepted it. */
export async function discardRunSeqOp(rowId: string): Promise<void> {
  await removeRunSeq([rowId]);
  announce();
}

export interface RunSeqFlushResult {
  flushed: number;
  conflicts: number;
  remaining: number;
}

/**
 * Replay every un-parked op. Each is an independent conditional UPDATE, so one
 * failure never blocks the rest — the outbox lesson from round 5, where a single
 * rejected upload could freeze the whole queue.
 */
export async function flushRunSeqOutbox(): Promise<RunSeqFlushResult> {
  const ops = (await listRunSeqOps()).filter((o) => !o.conflict);
  if (ops.length === 0) {
    const all = await listRunSeqOps();
    return { flushed: 0, conflicts: all.length, remaining: all.length };
  }
  const supabase = createClient();
  const done: string[] = [];
  const parked: RunSeqOp[] = [];

  for (const op of ops) {
    try {
      let q = supabase.from("run_sequence").update(op.patch).eq("id", op.rowId);
      for (const [k, v] of Object.entries(op.expect)) {
        q = v == null ? q.is(k, null) : q.eq(k, v);
      }
      const { data, error } = await q.select("id");
      // A network error is not a conflict — leave it queued and try again later.
      if (error) continue;
      const matched = data?.length ?? 0;
      // Only ask whether the row still exists when nothing matched; on the happy
      // path this would be a second round trip per op for no information.
      let stillExists = false;
      if (matched === 0) {
        const { data: probe, error: probeErr } = await supabase
          .from("run_sequence")
          .select("id")
          .eq("id", op.rowId)
          .maybeSingle();
        // Couldn't find out → don't guess. Leaving it queued is the reversible
        // choice; parking or dropping on a failed probe is not.
        if (probeErr) continue;
        stillExists = !!probe;
      }
      const verdict = classifyReplay(matched, stillExists);
      if (verdict === "conflict") parked.push(op);
      else done.push(op.rowId); // "done" or "dropped" — either way it leaves the queue
    } catch {
      /* transport blew up mid-flush — keep it queued */
    }
  }

  await removeRunSeq(done);
  await parkRunSeq(parked);
  const all = await listRunSeqOps();
  if (done.length > 0 || parked.length > 0) announce();
  return {
    flushed: done.length,
    conflicts: all.filter((o) => o.conflict).length,
    remaining: all.length,
  };
}
