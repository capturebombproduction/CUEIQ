// Durable offline queue for desktop MANAGEMENT writes (⭐#1 step 2 — design in
// docs/desktop-offline-management.md). Mirrors lib/show-run-outbox.ts (IndexedDB,
// best-effort, stop-at-first-network-failure) but management data is the
// "ONLINE WINS" conflict zone: a queued edit only applies on reconnect if the
// server row hasn't advanced past the value it was edited against — otherwise it's
// PARKED in a conflicts store for the user to resolve (keep mine / keep server).
// Nothing is ever silently dropped.
//
// Desktop-only: the web build never imports this file (web stays online-mgmt).
// All decision logic is pure + unit-tested in lib/mgmt-outbox.ts; this file is the
// thin I/O around it.
import { createClient } from "@/lib/supabase/client";
import {
  CHILD_TABLES,
  CHILD_WRITE_COLUMNS,
  childFlushDecision,
  isChildListOp,
  isQueueableWriteError,
  planEnqueue,
  shouldApplyOnFlush,
  type ChildListOp,
  type MgmtOp,
  type NewMgmtOp,
} from "@/lib/mgmt-outbox";
import { getStoredSessionUser } from "~/data/stored-session";

const DB_NAME = "cueiq-mgmt-outbox";
const OPS = "ops";
const CONFLICTS = "conflicts";

/** Fired after any queue change so the shell's status chips can refresh. */
export const MGMT_OUTBOX_EVENT = "cueiq:mgmt-outbox-change";

interface OpRec {
  op: NewMgmtOp;
  /** Owner check on a shared band device: never flush/overlay another account's ops. */
  userId: string | null;
  queuedAt: number;
}

export interface ConflictRec extends OpRec {
  parkedAt: number;
  reason: string;
}

function notify(): void {
  try {
    window.dispatchEvent(new Event(MGMT_OUTBOX_EVENT));
  } catch {
    /* non-DOM context */
  }
}

function currentUserId(): string | null {
  return getStoredSessionUser()?.id ?? null;
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
      // autoIncrement keys are monotonic per store → the key IS the op's seq.
      if (!db.objectStoreNames.contains(OPS)) db.createObjectStore(OPS, { autoIncrement: true });
      if (!db.objectStoreNames.contains(CONFLICTS))
        db.createObjectStore(CONFLICTS, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function listStore<T>(store: string): Promise<{ key: number; rec: T }[]> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const out: { key: number; rec: T }[] = [];
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            out.push({ key: Number(cursor.key), rec: cursor.value as T });
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
      })
  );
}

function deleteFrom(store: string, key: number): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      })
  );
}

async function listMyOps(): Promise<{ key: number; rec: OpRec }[]> {
  const uid = currentUserId();
  const all = await listStore<OpRec>(OPS);
  return all.filter((r) => r.rec.userId === uid).sort((a, b) => a.key - b.key);
}

/** Queue a management write (coalescing per event — see lib planEnqueue). */
export async function enqueueMgmtOp(op: NewMgmtOp): Promise<void> {
  const userId = currentUserId();
  const mine = await listMyOps();
  const plan = planEnqueue(
    mine.map((r) => ({ ...r.rec.op, seq: r.key }) as MgmtOp),
    op
  );
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OPS, "readwrite");
    const store = tx.objectStore(OPS);
    for (const seq of plan.dropSeqs) store.delete(seq);
    if (plan.op) {
      const rec: OpRec = { op: plan.op, userId, queuedAt: Date.now() };
      if (plan.replaceSeq != null) store.put(rec, plan.replaceSeq);
      else store.add(rec);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
  notify();
}

/** Current user's pending ops, seq order — the loaders' overlay input. */
export async function pendingMgmtOps(): Promise<MgmtOp[]> {
  try {
    const mine = await listMyOps();
    return mine.map((r) => ({ ...r.rec.op, seq: r.key }) as MgmtOp);
  } catch {
    return [];
  }
}

export async function pendingMgmtCount(): Promise<number> {
  return (await pendingMgmtOps()).length;
}

/** Current user's parked conflicts (with their store keys, for resolution). */
export async function listMgmtConflicts(): Promise<{ key: number; rec: ConflictRec }[]> {
  try {
    const uid = currentUserId();
    const all = await listStore<ConflictRec>(CONFLICTS);
    return all.filter((r) => r.rec.userId === uid).sort((a, b) => a.key - b.key);
  } catch {
    return [];
  }
}

async function parkConflict(rec: OpRec, reason: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(CONFLICTS, "readwrite");
    tx.objectStore(CONFLICTS).add({ ...rec, parkedAt: Date.now(), reason } satisfies ConflictRec);
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

/** Classify one failed write during a flush: still-offline throws, rejection parks. */
function failOrThrow(message: string, onLine: boolean): { conflict: string } {
  if (isQueueableWriteError(message, onLine)) throw new Error(message);
  return { conflict: message };
}

/**
 * Land one child-list snapshot (⭐#1 step 5): a guarded REPLACE-SET on the event's
 * rows in that table. Upsert the snapshot rows FIRST, then delete the rows the
 * snapshot no longer contains — crash-safe (no window where the data is gone) and
 * idempotent (a re-run upserts no-ops and re-deletes nothing). `force` skips the
 * online-wins guard (the user chose "ใช้ของฉัน" on a parked conflict).
 */
async function applyChildListOp(
  op: ChildListOp,
  onLine: boolean,
  force: boolean
): Promise<"applied" | { conflict: string }> {
  const supabase = createClient();
  const table = CHILD_TABLES[op.kind];
  const isLineup = op.kind === "lineup.upsert";

  if (!force) {
    // Online-wins guard: no updated_at on the child tables, so compare the
    // server's current rows (fingerprinted) against the rows this edit was based
    // on. See childFlushDecision for the already-applied re-run shortcut.
    const sel =
      op.kind === "lineup.upsert" ? "member_id" : CHILD_WRITE_COLUMNS[op.kind].join(",");
    const { data, error } = await supabase.from(table).select(sel).eq("event_id", op.id);
    if (error) return failOrThrow(error.message, onLine);
    const serverRows = isLineup
      ? ((data ?? []) as unknown as { member_id: string }[]).map((r) => r.member_id)
      : ((data ?? []) as unknown[]);
    const decision = childFlushDecision(op, serverRows);
    if (decision === "already-applied") return "applied";
    if (decision === "conflict") {
      return { conflict: "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" };
    }
  }

  if (isLineup) {
    const memberIds = op.rows as string[];
    if (memberIds.length) {
      const { error } = await supabase.from(table).upsert(
        memberIds.map((member_id) => ({
          tenant_id: op.tenantId,
          event_id: op.id,
          member_id,
        })),
        { onConflict: "event_id,member_id", ignoreDuplicates: true }
      );
      if (error) return failOrThrow(error.message, onLine);
    }
    let del = supabase.from(table).delete().eq("event_id", op.id);
    if (memberIds.length) del = del.not("member_id", "in", `(${memberIds.join(",")})`);
    const { error } = await del;
    if (error) return failOrThrow(error.message, onLine);
    return "applied";
  }

  const rows = op.rows as Record<string, unknown>[];
  if (rows.length) {
    const { error } = await supabase.from(table).upsert(rows);
    if (error) return failOrThrow(error.message, onLine);
  }
  let del = supabase.from(table).delete().eq("event_id", op.id);
  if (rows.length) del = del.not("id", "in", `(${rows.map((r) => r.id).join(",")})`);
  const { error } = await del;
  if (error) return failOrThrow(error.message, onLine);
  return "applied";
}

/**
 * Apply one op online. Returns "applied", or a conflict reason to park it.
 * Throws only on a NETWORK failure (still offline) — the flush loop stops there.
 */
async function applyOp(op: NewMgmtOp): Promise<"applied" | { conflict: string }> {
  const supabase = createClient();
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;

  if (isChildListOp(op)) return applyChildListOp(op, onLine, false);

  if (op.kind === "event.create") {
    // upsert on the client-minted id → idempotent when a half-flushed queue re-runs.
    const { error } = await supabase.from("events").upsert({ ...op.values, id: op.id });
    if (!error) return "applied";
    if (isQueueableWriteError(error.message, onLine)) throw new Error(error.message);
    return { conflict: error.message };
  }

  // Online-wins guard: read the server row's updated_at before touching it.
  const { data, error } = await supabase
    .from("events")
    .select("updated_at")
    .eq("id", op.id)
    .maybeSingle();
  if (error) {
    if (isQueueableWriteError(error.message, onLine)) throw new Error(error.message);
    return { conflict: error.message };
  }
  if (!data) {
    // Row gone: a delete already holds (idempotent); an edit has nothing to land on.
    if (op.kind === "event.delete") return "applied";
    return { conflict: "งานนี้ถูกลบไปแล้วบนออนไลน์" };
  }
  const parsed = Date.parse(data.updated_at as string);
  const serverMs = Number.isNaN(parsed) ? null : parsed;
  if (!shouldApplyOnFlush(op, serverMs)) {
    return { conflict: "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" };
  }

  const res =
    op.kind === "event.update"
      ? await supabase.from("events").update(op.patch).eq("id", op.id)
      : await supabase.from("events").delete().eq("id", op.id);
  if (!res.error) return "applied";
  if (isQueueableWriteError(res.error.message, onLine)) throw new Error(res.error.message);
  return { conflict: res.error.message };
}

/**
 * Replay the current user's queued ops in seq order. Stops at the first network
 * failure (still offline) and leaves the rest queued; a REJECTED op (RLS, online
 * changed first, row deleted) is parked as a conflict, never dropped.
 */
export async function flushMgmtOutbox(): Promise<{
  flushed: number;
  parked: number;
  remaining: number;
}> {
  let mine: { key: number; rec: OpRec }[];
  try {
    mine = await listMyOps();
  } catch {
    return { flushed: 0, parked: 0, remaining: 0 };
  }
  let flushed = 0;
  let parked = 0;
  for (const { key, rec } of mine) {
    let outcome: "applied" | { conflict: string };
    try {
      outcome = await applyOp(rec.op);
    } catch {
      break; // network still down — try again on the next reconnect
    }
    if (outcome !== "applied") {
      await parkConflict(rec, outcome.conflict);
      parked++;
    } else {
      flushed++;
    }
    await deleteFrom(OPS, key);
  }
  if (flushed || parked) notify();
  return { flushed, parked, remaining: mine.length - flushed - parked };
}

/**
 * Resolve a parked conflict. "server" keeps the online version (discard mine);
 * "mine" force-writes the queued value over the server row (the user explicitly
 * chose to override the online-wins default). Returns false when the force-write
 * itself failed (kept parked).
 */
export async function resolveMgmtConflict(
  key: number,
  choice: "mine" | "server"
): Promise<boolean> {
  if (choice === "mine") {
    const all = await listStore<ConflictRec>(CONFLICTS).catch(
      () => [] as { key: number; rec: ConflictRec }[]
    );
    const found = all.find((r) => r.key === key);
    if (found) {
      try {
        const supabase = createClient();
        const op = found.rec.op;
        if (isChildListOp(op)) {
          const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
          const res = await applyChildListOp(op, onLine, true);
          if (res !== "applied") return false;
        } else {
          const { error } =
            op.kind === "event.create"
              ? await supabase.from("events").upsert({ ...op.values, id: op.id })
              : op.kind === "event.update"
                ? await supabase.from("events").update(op.patch).eq("id", op.id)
                : await supabase.from("events").delete().eq("id", op.id);
          if (error) return false;
        }
      } catch {
        return false;
      }
    }
  }
  await deleteFrom(CONFLICTS, key);
  notify();
  return true;
}

/** Wipe everything (sign-out on a shared device — ops must not leak across users). */
export async function clearMgmtOutbox(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([OPS, CONFLICTS], "readwrite");
      tx.objectStore(OPS).clear();
      tx.objectStore(CONFLICTS).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    /* best-effort */
  }
  notify();
}
