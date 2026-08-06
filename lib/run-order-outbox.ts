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
//
// ⚠️ AND THE REPLAY MUST NEVER TRUST AN UNAUTHENTICATED ANSWER. The flush runs on
// the 'online' event, which is exactly the minute supabase-js sends requests as
// ANON (a token whose refresh failed is cached for about that long — see
// lib/auth-session.ts). As anon, RLS answers the conditional UPDATE with 0 rows
// and the existence probe with "no such row", both without an error. Believing
// that pair means classifying every queued press as "the builder deleted my row"
// and DESTROYING a whole festival's record on the strength of a request that was
// never allowed to do anything. So: no session, no verdict — leave it queued.
import { createClient } from "@/lib/supabase/client";
import { settleOnAbort } from "@/lib/idb-tx";
import { hasLiveSession } from "@/lib/auth-session";
import { privateChannel } from "@/lib/realtime";

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
  /**
   * Bumped by every put. The flush deletes a record only when the rev it applied
   * is still the one stored — a press the operator made DURING the flush merges
   * into the same key, and deleting by key alone would throw that press away.
   * Optional so records queued by an older build still flush (they read as 0).
   */
  rev?: number;
  /**
   * The realtime topic of the board this row belongs to, so the flush can tell the
   * other devices that the replayed presses landed. Without it a band watching the
   * run-status card stays on the pre-outage act for the rest of the night: the
   * offline device's own broadcast reached nobody, and the write that finally
   * lands comes from a queue with no channel open. Optional for older records.
   */
  topic?: string;
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
  if (!prev) return { ...next, rev: (next.rev ?? 0) + 1 };
  return {
    ...next,
    // the label + timestamp of the LATEST press describe where the row now is
    patch: { ...prev.patch, ...next.patch },
    // ...but the precondition must still describe the last SERVER state we saw
    expect: prev.expect,
    queuedAt: prev.queuedAt,
    // a row that already parked stays parked until a human clears it
    conflict: prev.conflict,
    // every put is a new revision — the flush compares this before deleting
    rev: (prev.rev ?? 0) + 1,
    topic: next.topic ?? prev.topic,
  };
}

/**
 * Lay the still-pending presses back over a set of server (or cached) rows.
 *
 * The queue is the only record of what the operator did offline, so any row state
 * that did not come through it is a older truth wearing a newer face. Three
 * different screens were showing that face: a reconnect refetch resolving before
 * the flush had replayed anything, the desktop board remounting from its read
 * cache after a restart, and any refetch triggered by another device's broadcast.
 * All of them put the board back to where it stood BEFORE the presses — in front
 * of an operator who cannot re-press what they already pressed.
 *
 * PARKED ops are deliberately not overlaid: a conflict is exactly the case where
 * the human needs to see what the server really holds before deciding.
 */
export function applyRunSeqOverlay<T extends { id: string }>(
  rows: T[],
  ops: RunSeqOp[]
): T[] {
  const live = ops.filter((o) => !o.conflict);
  if (live.length === 0) return rows;
  const byRow = new Map(live.map((o) => [o.rowId, o.patch]));
  return rows.map((r) => {
    const patch = byRow.get(r.id);
    return patch ? ({ ...r, ...patch } as T) : r;
  });
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

/** The op currently stored for a row, or undefined. */
async function getRunSeqOp(rowId: string): Promise<RunSeqOp | undefined> {
  try {
    const db = await openDB();
    return await new Promise<RunSeqOp | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(rowId);
      req.onsuccess = () => resolve(req.result as RunSeqOp | undefined);
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
    return undefined;
  }
}

/**
 * The op survived its own replay — a press merged into it while that replay was
 * in flight — so its precondition now describes state the server has just moved
 * PAST. Left alone it can only ever match zero rows, and the operator's press
 * would be parked as a conflict they never caused and shown as someone else's
 * doing. Rebase it: the columns the replay committed ARE the server's state now,
 * so they become the new precondition. The press replays against live truth.
 */
async function rebaseExpect(replayed: RunSeqOp): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(replayed.rowId);
      get.onsuccess = () => {
        const cur = get.result as RunSeqOp | undefined;
        // Only the record that actually superseded the replayed one, and only
        // while it is still un-parked.
        if (!cur || cur.conflict || (cur.rev ?? 0) === (replayed.rev ?? 0)) return;
        const next: RunSeqPatch = { ...replayed.expect };
        for (const k of Object.keys(replayed.expect) as (keyof RunSeqPatch)[]) {
          if (k in replayed.patch) {
            (next as Record<string, unknown>)[k] = (
              replayed.patch as Record<string, unknown>
            )[k];
          }
        }
        store.put({ ...cur, expect: compactPatch(next) }, cur.rowId);
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
  } catch {
    /* best-effort — the next flush parks it, which is recoverable by hand */
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

/**
 * Post-replay delete: drop each record ONLY while it still holds the rev that was
 * replayed. The flush is a loop of network round trips on venue wifi, and the
 * operator keeps pressing buttons throughout — a press made during the flush
 * merges into the same key and bumps its rev, and deleting by key alone would
 * silently destroy that never-sent press. (The management outbox learned this
 * first; see deleteOpIfRevMatches in desktop/src/data/mgmt-outbox.ts.)
 */
async function removeRunSeqIfRev(
  entries: { rowId: string; rev: number }[]
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      entries.forEach(({ rowId, rev }) => {
        const get = store.get(rowId);
        get.onsuccess = () => {
          const cur = get.result as RunSeqOp | undefined;
          if (cur && (cur.rev ?? 0) === rev) store.delete(rowId);
        };
      });
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
      // Read-modify-write, never a blind put of the snapshot this flush started
      // with: a press made while the flush was running has already merged into
      // this key, and writing the old object back would erase it.
      ops.forEach((o) => {
        const get = store.get(o.rowId);
        get.onsuccess = () => {
          const cur = (get.result as RunSeqOp | undefined) ?? o;
          store.put({ ...cur, conflict: true }, o.rowId);
        };
      });
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
 * Tell the other devices that replayed presses have landed.
 *
 * Every ONLINE writer on this board broadcasts after it writes; the queue was the
 * one writer that stayed silent, so bands watching the run-status card kept the
 * act that was live when the wifi died. Best-effort by design: the rows are on the
 * server either way, and a broadcast that never goes out costs a refresh, not a
 * record.
 */
function broadcastRunOrderChanged(topics: string[]): void {
  if (topics.length === 0) return;
  const supabase = createClient();
  for (const topic of topics) {
    try {
      // ⚠️ THE CHANNEL MAY ALREADY BE OURS. The browser supabase client is a
      // singleton and realtime dedupes by topic, so when the show-caller is
      // sitting on the board — the normal case for a flush — asking for this
      // topic hands back the channel that board is already joined to. Two things
      // follow, and both bit: subscribe() on a joined channel returns without
      // ever invoking the callback (so a send nested inside it never happens),
      // and removing it would tear the board's own channel out from under it,
      // leaving that screen deaf to every other device for the rest of its life.
      // So: send on an existing channel and leave it alone; only create, and only
      // tear down, a channel we made ourselves.
      const existing = supabase
        .getChannels()
        .find((c) => c.topic === `realtime:${topic}` || c.topic === topic);
      if (existing) {
        existing.send({ type: "broadcast", event: "changed", payload: {} });
        continue;
      }
      const ch = privateChannel(supabase, topic);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.send({ type: "broadcast", event: "changed", payload: {} });
          setTimeout(() => supabase.removeChannel(ch), 600);
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          // Otherwise a failed join strands a channel that still holds the topic,
          // which a board mounting later would then be handed instead of its own.
          supabase.removeChannel(ch);
        }
      });
    } catch {
      /* realtime unavailable — the writes still landed */
    }
  }
}

let inFlightFlush: Promise<RunSeqFlushResult> | null = null;

/**
 * Replay every un-parked op. Each is an independent conditional UPDATE, so one
 * failure never blocks the rest — the outbox lesson from round 5, where a single
 * rejected upload could freeze the whole queue.
 *
 * Re-entrant-safe: boot and the 'online' listener can fire together, and on the
 * web every open tab mounts its own OutboxFlusher over the SAME IndexedDB. Two
 * passes replaying one op means the second one's precondition — already consumed
 * by the first — matches nothing, and the operator is shown a red conflict panel
 * for a press that landed perfectly.
 */
export function flushRunSeqOutbox(): Promise<RunSeqFlushResult> {
  if (inFlightFlush) return inFlightFlush;
  const run = doFlush().finally(() => {
    inFlightFlush = null;
  });
  inFlightFlush = run;
  return run;
}

async function doFlush(): Promise<RunSeqFlushResult> {
  const ops = (await listRunSeqOps()).filter((o) => !o.conflict);
  if (ops.length === 0) {
    const all = await listRunSeqOps();
    return { flushed: 0, conflicts: all.length, remaining: all.length };
  }
  // Nothing here is safe to judge without a session (see the header): as anon the
  // UPDATE matches nothing and the probe finds nothing, which reads exactly like
  // "the builder deleted every row". Check once up front — cheap, and it keeps a
  // whole night's presses queued instead of classified away.
  if (!(await hasLiveSession())) {
    const all = await listRunSeqOps();
    return { flushed: 0, conflicts: all.filter((o) => o.conflict).length, remaining: all.length };
  }
  const supabase = createClient();
  const done: { rowId: string; rev: number }[] = [];
  const parked: RunSeqOp[] = [];
  const topics = new Set<string>();

  for (const snapshot of ops) {
    try {
      // Re-read the op as it stands NOW, not as the snapshot at the top of this
      // flush saw it. The operator keeps pressing while a flush is working
      // through a queue on venue wifi, and every press merges into the row's
      // record — sending the stale one would leave the merged press holding a
      // precondition this write is about to consume.
      const op = (await getRunSeqOp(snapshot.rowId)) ?? snapshot;
      if (op.conflict) continue; // parked while we were working
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
        // The session can also expire DURING the flush — a long queue on venue
        // wifi is minutes of round trips. Re-ask before reading anything into an
        // empty answer, because from here the next step either parks or deletes.
        if (!(await hasLiveSession())) continue;
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
      else {
        // "done" or "dropped" — either way it leaves the queue, and it leaves NOW
        // rather than after the loop. A flush is minutes of round trips on venue
        // wifi and the operator keeps pressing throughout: while this op still
        // sat in the store, a new press merged into it and inherited a
        // precondition this replay had just consumed, so it was guaranteed to
        // park as a false conflict. Removing per-op — and announcing it — means
        // the next press starts a fresh op against state the server now holds.
        done.push({ rowId: op.rowId, rev: op.rev ?? 0 });
        await removeRunSeqIfRev([{ rowId: op.rowId, rev: op.rev ?? 0 }]);
        // A press that merged in during THIS op's round trip is still stored (the
        // rev no longer matches, so the delete above declined it) — and its
        // precondition is the one this write just consumed. Move it forward onto
        // what the server now holds, or its next replay parks as a conflict the
        // operator never caused and their press is dropped from the board.
        if (verdict === "done") await rebaseExpect(op);
        announce();
        if (verdict === "done" && op.topic) topics.add(op.topic);
      }
    } catch {
      /* transport blew up mid-flush — keep it queued */
    }
  }

  await parkRunSeq(parked);
  const all = await listRunSeqOps();
  if (done.length > 0 || parked.length > 0) announce();
  broadcastRunOrderChanged([...topics]);
  return {
    flushed: done.length,
    conflicts: all.filter((o) => o.conflict).length,
    remaining: all.length,
  };
}
