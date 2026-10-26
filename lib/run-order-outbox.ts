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
// actually observed) and the LATEST value of each column.
//
// ⚠️ BUT A PRESS IS NOT A ROW. "จบ + ต่อไป" writes two rows (the live act → done, the
// next → live), and the rows used to replay as independent compare-and-swaps. When
// another device had driven the board meanwhile, the rows it had moved parked and
// the row it had not reached yet still read `pending` — so the half of the press
// that started the next act landed alone: two acts live, and the act after them
// never called (2026-10-26). So every op carries the ids of the presses folded into
// it (`presses`), and ops that share a press — directly, or through a row two
// presses both touched — replay as ONE unit: checked together before anything is
// written, and parked together when any of them parks. No migration: the unit
// exists only in this queue.
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
import { notify } from "@/lib/notify-client";

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
  /**
   * Every EARLIER version of `patch`, oldest first - set when a press merges in.
   * Any of them may already be on the server: the first press was queued after its
   * own attempt failed, and a replay can commit while its answer is lost. When the
   * row holds one of them, the replay rebases onto it instead of parking the
   * operator's own presses as a conflict (2026-10-25). Optional for older records.
   */
  prior?: RunSeqPatch[];
  /**
   * Set on the show's FIRST start when it could not go out (no network, or its answer was
   * lost): the event the board was opened from, and when the press was made. Once the replay
   * lands, the label is told the show went live ("🔴 งานเริ่มแล้ว"). The press could not tell
   * it - /api/notify only believes a live row the server holds - and a start that replayed
   * later told nobody (2026-10-26). Optional for older records.
   */
  announceLive?: { eventId: string; at: number };
  /**
   * The id of every press folded into this op (see the header: a press is not a row).
   * Ops that share one replay as a unit and park as a unit. Optional for older
   * records, which replay on their own as before.
   */
  presses?: string[];
}

/** A fresh id for one press - every row that press writes carries it. */
export function newRunSeqPressId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A start that lands later than this after its press is old news: nobody is told it went
 *  live (the route would believe it - the row is live for the whole show - and a festival
 *  started at 14:00 would push "งานเริ่มแล้ว" at 20:00). */
export const ANNOUNCE_LIVE_WITHIN_MS = 30 * 60_000;

/** How many earlier versions an op keeps - a row gets a handful of presses offline. */
const MAX_PRIOR = 20;

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
    // the version this press replaces may already be on the server - see `prior`
    prior: [...(prev.prior ?? []), prev.patch].slice(-MAX_PRIOR),
    // the first start's word to the label rides every press folded in after it
    announceLive: prev.announceLive ?? next.announceLive,
    // this row now carries every press that touched it - which is what ties a later
    // press to the earlier ones it was built on
    presses: [...new Set([...(prev.presses ?? []), ...(next.presses ?? [])])],
  };
}

/**
 * The ops that must replay as one unit, each unit in replay order.
 *
 * Two ops belong together when they share a press, and the relation is transitive:
 * "A→B" then "B→C" offline gives A{p1}, B{p1,p2}, C{p2} - one unit, because C's
 * start was built on B's, which was built on A's end. An op with no press ids (an
 * older record) is a unit of its own.
 *
 * Inside a unit: every row being ENDED first, then the rest, oldest press first - a
 * unit cut short by the network then leaves the board with no act live for a moment
 * rather than two. Ending first, not oldest first: a merged op keeps its FIRST press's
 * queuedAt, so a row drained by an older ดึง buffer and started by a later "จบ + ต่อไป"
 * sorted before the act that press ended - and went live while it was still live
 * (2026-10-26, ตาที่ 3). Each row is its own compare-and-swap, so the order between
 * rows never changes what lands, only what a cut leaves behind.
 */
export function groupRunSeqPresses(ops: RunSeqOp[]): RunSeqOp[][] {
  const parent = ops.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner = new Map<string, number>();
  ops.forEach((o, i) => {
    for (const p of o.presses ?? []) {
      const j = owner.get(p);
      if (j === undefined) owner.set(p, i);
      else parent[find(i)] = find(j);
    }
  });
  const units = new Map<number, number[]>();
  ops.forEach((_, i) => {
    const root = find(i);
    const list = units.get(root);
    if (list) list.push(i);
    else units.set(root, [i]);
  });
  const ending = (o: RunSeqOp) => (o.patch.status === "done" ? 0 : 1);
  return [...units.values()].map((idx) =>
    idx
      .sort(
        (a, b) =>
          ending(ops[a]) - ending(ops[b]) || ops[a].queuedAt - ops[b].queuedAt || a - b
      )
      .map((i) => ops[i])
  );
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
  stillExists: boolean,
  alreadyHolds = false
): "done" | "dropped" | "conflict" {
  if (rows > 0) return "done";
  if (!stillExists) return "dropped";
  // The row matched nothing because it ALREADY says what we were going to write:
  // our own earlier attempt landed and only its answer was lost (venue wifi drops
  // the response as readily as the request). That is this press, done — not
  // someone else driving the board.
  return alreadyHolds ? "done" : "conflict";
}

/** The columns a probe may read back — the patch's own, never anything else. */
const PATCH_COLUMNS: (keyof RunSeqPatch)[] = [
  "status",
  "actual_start",
  "actual_end",
  "offset_min",
  "buffer_seconds",
];

/**
 * Does the server row already hold every value this patch writes? Timestamps are
 * compared as instants: PostgREST answers `…+00:00` for what we sent as `….000Z`.
 */
export function patchAlreadyHolds(patch: RunSeqPatch, row: Record<string, unknown>): boolean {
  const keys = PATCH_COLUMNS.filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return false;
  return keys.every((k) => columnHolds(k, patch[k], row[k]));
}

function columnHolds(k: keyof RunSeqPatch, want: unknown, have: unknown): boolean {
  if (want === null || have === null || have === undefined) return want === null && have == null;
  if (k === "actual_start" || k === "actual_end") {
    const a = Date.parse(String(want));
    const b = Date.parse(String(have));
    return Number.isFinite(a) && a === b;
  }
  return String(want) === String(have);
}

/** Would the conditional UPDATE match this row - does it hold every value `expect`
 *  names (null = IS NULL)? An empty expect matches anything, as the write does. */
export function expectHolds(expect: RunSeqPatch, row: Record<string, unknown>): boolean {
  return PATCH_COLUMNS.every((k) => expect[k] === undefined || columnHolds(k, expect[k], row[k]));
}

/**
 * Would this op land on this row - its precondition holds, or the row already says
 * what it writes, or an earlier version landed and the rebased precondition holds?
 * The same three ways the replay itself can end in "done" (see doFlush).
 */
export function opWouldLand(op: RunSeqOp, row: Record<string, unknown>): boolean {
  if (expectHolds(op.expect, row) || patchAlreadyHolds(op.patch, row)) return true;
  const landed = earlierPatchHeld(op, row);
  return !!landed && expectHolds(expectOnto(op.expect, landed), row);
}

/**
 * The newest EARLIER version of this op's patch that the server row already holds,
 * or null. That attempt landed and only its answer was lost; a later press then
 * merged in, so the op's own expect (the state before the FIRST press) can no longer
 * match and the merged patch is not what the row holds either (2026-10-25).
 */
export function earlierPatchHeld(op: RunSeqOp, row: Record<string, unknown>): RunSeqPatch | null {
  const prior = op.prior ?? [];
  for (let i = prior.length - 1; i >= 0; i--) {
    if (patchAlreadyHolds(prior[i], row)) return prior[i];
  }
  return null;
}

/** A precondition moved onto the state `landed` left: each expected column it wrote
 *  now holds its value; the rest are unchanged. */
export function expectOnto(expect: RunSeqPatch, landed: RunSeqPatch): RunSeqPatch {
  const next: RunSeqPatch = { ...expect };
  for (const k of Object.keys(expect) as (keyof RunSeqPatch)[]) {
    if (k in landed) {
      (next as Record<string, unknown>)[k] = (landed as Record<string, unknown>)[k];
    }
  }
  return compactPatch(next);
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

// ---------------------------------------------------------------------------
// The word that the queue changed - to this window AND to the other tabs.
//
// Every web tab mounts its own OutboxFlusher over the SAME IndexedDB, so the tab
// that replays the presses is often not the tab showing the board (the Overview in
// one tab, คุมคิว Live in another: switching tabs flushes in the one that became
// visible). A window event reaches its own window only, and the board kept laying
// already-landed presses over every refetch (2026-10-26). A BroadcastChannel carries
// the word to the other tabs, which turn it back into their own window event.
// ---------------------------------------------------------------------------
const OUTBOX_CHANNEL = "cueiq:runseq-outbox";
/** This module's copy, so a tab does not hear its own word twice. */
const tabId = newRunSeqPressId();
let sender: BroadcastChannel | null = null;

/** Node's channel (tests) holds the process open; the browser's has no unref. */
function unrefChannel(ch: BroadcastChannel): void {
  (ch as unknown as { unref?: () => void }).unref?.();
}

function announce(crossTab = true): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(RUNSEQ_OUTBOX_EVENT));
  if (!crossTab || typeof BroadcastChannel === "undefined") return;
  try {
    if (!sender) {
      sender = new BroadcastChannel(OUTBOX_CHANNEL);
      unrefChannel(sender);
    }
    sender.postMessage({ from: tabId });
  } catch {
    /* best-effort: the other tab re-reads on its own refetch and focus anyway */
  }
}

/**
 * Run `cb` whenever the queue may have changed - in this window or in another tab
 * of this browser. Returns the unsubscribe. Screens listen through this rather than
 * on RUNSEQ_OUTBOX_EVENT alone, which only ever hears this window.
 */
export function onRunSeqOutboxChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(RUNSEQ_OUTBOX_EVENT, cb);
  let ch: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      ch = new BroadcastChannel(OUTBOX_CHANNEL);
      unrefChannel(ch);
      ch.onmessage = (e: MessageEvent) => {
        if ((e.data as { from?: string } | null)?.from !== tabId) cb();
      };
    }
  } catch {
    ch = null;
  }
  return () => {
    window.removeEventListener(RUNSEQ_OUTBOX_EVENT, cb);
    ch?.close();
  };
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
        store.put({ ...cur, expect: expectOnto(replayed.expect, replayed.patch) }, cur.rowId);
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
 * Replay every un-parked op, one PRESS at a time (see the header). Each row is a
 * conditional UPDATE and each press is independent of the others, so one failure
 * never blocks the rest — the outbox lesson from round 5, where a single rejected
 * upload could freeze the whole queue.
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

/**
 * Before ANY row of a multi-row press is written: would every one of them land?
 *
 *  • "go"   — yes (a row the builder deleted does not stop it: that op is dropped,
 *             as it would be alone).
 *  • "park" — one of them no longer holds what the press branched from, so writing
 *             the others would land half a press. A human looks at the whole of it.
 *  • "wait" — could not find out (network, or an empty answer with no proven
 *             session - the header's anon minute). Leave it queued.
 *
 * Still a check, not a lock: a device that moves a row between this read and the
 * writes makes that write park, and doFlush then parks the rest of the press
 * unsent - the same window an online "จบ + ต่อไป" has between its two requests.
 */
async function precheckPress(
  supabase: ReturnType<typeof createClient>,
  members: RunSeqOp[]
): Promise<"go" | "park" | "wait"> {
  // as they stand NOW - a press made during the flush may have merged in
  const ops = await Promise.all(members.map(async (m) => (await getRunSeqOp(m.rowId)) ?? m));
  if (ops.some((o) => o.conflict)) return "park";
  const ids = ops.map((o) => o.rowId);
  const { data, error } = await supabase
    .from("run_sequence")
    .select(["id", ...PATCH_COLUMNS].join(", "))
    .in("id", ids);
  if (error || !data) return "wait";
  const byId = new Map(
    (data as unknown as Record<string, unknown>[]).map((r) => [String(r.id), r])
  );
  // fewer rows than asked for reads like "deleted" - and like anon (see the header)
  if (ids.some((id) => !byId.has(id)) && !(await hasLiveSession())) return "wait";
  for (const op of ops) {
    const row = byId.get(op.rowId);
    if (row && !opWouldLand(op, row)) return "park";
  }
  return "go";
}

async function doFlush(): Promise<RunSeqFlushResult> {
  const queue = await listRunSeqOps();
  const ops = queue.filter((o) => !o.conflict);
  if (ops.length === 0) {
    // Nothing to replay HERE - but another tab may just have drained what this
    // tab's board still lays over its rows. Tell this window to re-read (only this
    // window: nothing changed, so there is nothing to tell the other tabs).
    announce(false);
    return { flushed: 0, conflicts: queue.length, remaining: queue.length };
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
  // the show's first start landed from the queue: the events whose label is told (announceLive)
  const goneLive = new Set<string>();

  /** Replay one op. "wait" = could not find out (network, no session): leave it queued. */
  const replayOne = async (
    snapshot: RunSeqOp
  ): Promise<"done" | "dropped" | "conflict" | "wait"> => {
    try {
      // Re-read the op as it stands NOW, not as the snapshot at the top of this
      // flush saw it. The operator keeps pressing while a flush is working
      // through a queue on venue wifi, and every press merges into the row's
      // record — sending the stale one would leave the merged press holding a
      // precondition this write is about to consume.
      const op = (await getRunSeqOp(snapshot.rowId)) ?? snapshot;
      if (op.conflict) return "conflict"; // parked while we were working
      const send = (expect: RunSeqPatch) => {
        let q = supabase.from("run_sequence").update(op.patch).eq("id", op.rowId);
        for (const [k, v] of Object.entries(expect)) {
          q = v == null ? q.is(k, null) : q.eq(k, v);
        }
        return q.select("id");
      };
      // what was actually replayed - its expect moves if the retry below rebases it
      let replayed = op;
      const { data, error } = await send(op.expect);
      // A network error is not a conflict — leave it queued and try again later.
      if (error) return "wait";
      let matched = data?.length ?? 0;
      // Only ask whether the row still exists when nothing matched; on the happy
      // path this would be a second round trip per op for no information.
      let stillExists = false;
      let alreadyHolds = false;
      if (matched === 0) {
        // The session can also expire DURING the flush — a long queue on venue
        // wifi is minutes of round trips. Re-ask before reading anything into an
        // empty answer, because from here the next step either parks or deletes.
        if (!(await hasLiveSession())) return "wait";
        // Read back the patched columns too, so "the row already says this" (an
        // earlier attempt whose answer was lost) is not parked as a conflict.
        const cols = PATCH_COLUMNS.filter(
          (k) => op.patch[k] !== undefined || (op.prior ?? []).some((p) => p[k] !== undefined)
        );
        const { data: probe, error: probeErr } = await supabase
          .from("run_sequence")
          .select(["id", ...cols].join(", "))
          .eq("id", op.rowId)
          .maybeSingle();
        // Couldn't find out → don't guess. Leaving it queued is the reversible
        // choice; parking or dropping on a failed probe is not.
        if (probeErr) return "wait";
        stillExists = !!probe;
        const row = probe as unknown as Record<string, unknown> | null;
        alreadyHolds = !!row && patchAlreadyHolds(op.patch, row);
        // The row holds an EARLIER version of this op (that attempt landed, its answer
        // was lost, then a press merged in): the server has moved exactly as this device
        // did, so move the precondition onto that state and retry ONCE (2026-10-25). Still
        // a compare-and-swap - a row someone else moved meanwhile matches nothing and parks.
        const landed = row && !alreadyHolds ? earlierPatchHeld(op, row) : null;
        if (landed) {
          const rebased = expectOnto(op.expect, landed);
          if (JSON.stringify(rebased) !== JSON.stringify(op.expect)) {
            replayed = { ...op, expect: rebased };
            const retry = await send(rebased);
            if (retry.error) return "wait"; // network - stays queued, judged again next flush
            matched = retry.data?.length ?? 0;
            // 0 rows as anon reads like "moved" too - no session, no verdict (header)
            if (matched === 0 && !(await hasLiveSession())) return "wait";
          }
        }
      }
      const verdict = classifyReplay(matched, stillExists, alreadyHolds);
      if (verdict === "conflict") return "conflict";
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
      if (verdict === "done") await rebaseExpect(replayed);
      announce();
      if (verdict === "done" && op.topic) topics.add(op.topic);
      const word = op.announceLive;
      if (verdict === "done" && word && Date.now() - word.at <= ANNOUNCE_LIVE_WITHIN_MS) goneLive.add(word.eventId);
      return verdict;
    } catch {
      return "wait"; // transport blew up mid-flush — keep it queued
    }
  };

  // One PRESS at a time, not one row (see the header). Each unit is still
  // independent of the others, so one failure never blocks the rest — the outbox
  // lesson from round 5, where a single rejected upload could freeze the whole queue.
  for (const unit of groupRunSeqPresses(queue)) {
    const members = unit.filter((o) => !o.conflict);
    if (members.length === 0) continue;
    // The units were cut from the queue as it stood when this flush began. A press made
    // since may have merged into one of these rows AND written rows outside the unit
    // ("จบ + ต่อไป" on a row that only held a drift): replaying this unit now would land
    // that press's first half alone. Leave it for the next flush, which groups it whole.
    const known = new Set(unit.flatMap((o) => o.presses ?? []));
    const fresh = await Promise.all(members.map((m) => getRunSeqOp(m.rowId)));
    if (fresh.some((o) => (o?.presses ?? []).some((p) => !known.has(p)))) continue;
    // A press these were built on has already parked: replaying them now is exactly
    // the half-a-press this grouping exists to stop.
    if (members.length < unit.length) {
      parked.push(...members);
      continue;
    }
    if (members.length > 1) {
      const pre = await precheckPress(supabase, members);
      if (pre === "wait") continue;
      if (pre === "park") {
        parked.push(...members);
        continue;
      }
    }
    for (let i = 0; i < members.length; i++) {
      const outcome = await replayOne(members[i]);
      if (outcome === "conflict") {
        // this row, and the rest of its press unsent - what already landed stays
        parked.push(...members.slice(i));
        break;
      }
      // couldn't find out: the rest of the press waits with it for the next flush
      if (outcome === "wait") break;
    }
  }

  await parkRunSeq(parked);
  const all = await listRunSeqOps();
  if (done.length > 0 || parked.length > 0) announce();
  broadcastRunOrderChanged([...topics]);
  // after the writes, as the online press does: the route re-checks the festival has a live
  // row, and dedupes a second word inside its window
  for (const eventId of goneLive) notify("run_order_live", { eventId });
  return {
    flushed: done.length,
    conflicts: all.filter((o) => o.conflict).length,
    remaining: all.length,
  };
}
