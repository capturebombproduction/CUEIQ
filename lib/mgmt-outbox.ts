// Offline MANAGEMENT outbox — the PURE core (⭐#1 step 2, design in
// docs/desktop-offline-management.md). This file holds only the deterministic,
// side-effect-free logic:
//   • applyPending  — overlay queued offline writes onto a server/cache list so an
//                     offline create/edit is VISIBLE immediately (the trap that
//                     sank the earlier naive attempt: "saved but can't open it").
//   • shouldApplyOnFlush — the "online wins" reconciliation guard for the master
//                     zone (docs/offline-first-plan.md §5): a queued edit is applied
//                     on reconnect ONLY if the server row hasn't advanced past the
//                     value we edited against; otherwise it's a conflict to park.
//   • newEventId    — a client-minted uuid PK so an offline-created event has a
//                     stable id up front (no temp→real id remap on flush).
//   • planEnqueue   — coalesce a new write into the queue (one op per event) so a
//                     flushed op can't false-conflict a later op for the same row.
//   • materializeEventRow / describeOp / isQueueableWriteError — display + flush
//                     classification helpers shared by the desktop wiring.
//
// NOT here (deliberately): the IndexedDB queue I/O and the flush loop — they live in
// desktop/src/data/mgmt-outbox.ts so the web build never carries them. This file
// stays pure (unit-tested in lib/mgmt-outbox.test.ts) and is shared by the desktop
// queue, the loader overlays, and the EventForm write seam (lib/mgmt-write.ts).
import type { EventRow } from "@/lib/types";

/**
 * A management write before it's queued — no `seq` yet (the queue assigns one).
 * `base` is the epoch-ms `updated_at` of the row the edit was made against — null
 * when unknown; used by shouldApplyOnFlush to detect "the server changed under me".
 */
export type NewMgmtOp =
  | { kind: "event.create"; id: string; values: Partial<EventRow> }
  | { kind: "event.update"; id: string; patch: Partial<EventRow>; base: number | null }
  | { kind: "event.delete"; id: string; base: number | null };

/**
 * A queued offline management write. `seq` is a per-device monotonic counter so a
 * create-then-edits replays in the exact order it was made.
 */
export type MgmtOp = NewMgmtOp & { seq: number };

/** Ascending by seq — the order the writes happened, so replay/overlay is stable. */
function bySeq(a: MgmtOp, b: MgmtOp): number {
  return a.seq - b.seq;
}

/**
 * Overlay the pending ops onto a list of rows (keyed by `id`). Pure — returns a new
 * array, never mutates. A create for an id already present is skipped (the server
 * caught up); an update shallow-merges its patch; a delete drops the row.
 */
export function applyPending<T extends { id: string }>(rows: T[], ops: MgmtOp[]): T[] {
  let out = rows.slice();
  for (const op of ops.slice().sort(bySeq)) {
    if (op.kind === "event.create") {
      if (!out.some((r) => r.id === op.id)) {
        // A freshly-created offline event: surface it at the top with its client id.
        out = [{ ...op.values, id: op.id } as unknown as T, ...out];
      }
    } else if (op.kind === "event.update") {
      out = out.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r));
    } else {
      out = out.filter((r) => r.id !== op.id);
    }
  }
  return out;
}

/**
 * "Online wins" reconciliation for the master/stage zone: on reconnect, a queued
 * edit is applied ONLY if the server row hasn't changed since we based our edit on
 * it. A create always applies (brand-new row, no base). A missing base or unknown
 * server timestamp falls through to apply (best-effort — we only BLOCK when we can
 * prove the server moved ahead). Returns false → park the op as a conflict.
 */
export function shouldApplyOnFlush(op: NewMgmtOp, serverUpdatedAtMs: number | null): boolean {
  if (op.kind === "event.create") return true;
  if (op.base == null || serverUpdatedAtMs == null) return true;
  return serverUpdatedAtMs <= op.base;
}

/**
 * Coalesce an incoming write into the queue (pure planner — the IndexedDB layer
 * executes the plan). Mirrors show-run-outbox's "last value per datum" so the queue
 * never holds two ops for the same event. That matters beyond tidiness: flushing
 * op 1 bumps the server's `updated_at`, so a SECOND queued edit for the same event
 * (whose `base` predates our own flush) would trip the online-wins guard and park
 * as a false conflict. Merging at enqueue time makes that impossible.
 *   • update onto a queued create → fold the patch into the create's values
 *   • update onto a queued update → merge patches, keep the ORIGINAL base
 *   • delete onto a queued create → both cancel out (server never saw the row)
 *   • delete onto a queued update → the delete supersedes it
 */
export interface EnqueuePlan {
  /** Existing queue records to remove (superseded / cancelled out). */
  dropSeqs: number[];
  /** Overwrite this existing record with `op` (null → append as a new record). */
  replaceSeq: number | null;
  /** The op to store — null when the write cancelled out entirely. */
  op: NewMgmtOp | null;
}

export function planEnqueue(existing: MgmtOp[], incoming: NewMgmtOp): EnqueuePlan {
  if (incoming.kind === "event.create") {
    // Creates mint a fresh uuid — they can never coalesce with anything.
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }
  const mine = existing.filter((o) => o.id === incoming.id).sort(bySeq);
  const create = mine.find((o) => o.kind === "event.create");
  const update = mine.find((o) => o.kind === "event.update");
  const del = mine.find((o) => o.kind === "event.delete");

  if (incoming.kind === "event.update") {
    if (create && create.kind === "event.create") {
      return {
        dropSeqs: [],
        replaceSeq: create.seq,
        op: { kind: "event.create", id: incoming.id, values: { ...create.values, ...incoming.patch } },
      };
    }
    if (update && update.kind === "event.update") {
      return {
        dropSeqs: [],
        replaceSeq: update.seq,
        op: {
          kind: "event.update",
          id: incoming.id,
          patch: { ...update.patch, ...incoming.patch },
          // Both edits were made against the same last-seen server row — the base
          // must stay the ORIGINAL timestamp, or the guard loses its reference.
          base: update.base,
        },
      };
    }
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }

  // incoming delete
  if (create) {
    // Created offline then deleted offline: the server never saw this event —
    // drop every queued op for it and store nothing.
    return { dropSeqs: mine.map((o) => o.seq), replaceSeq: null, op: null };
  }
  return {
    dropSeqs: update ? [update.seq] : [],
    replaceSeq: del ? del.seq : null,
    op: incoming,
  };
}

/**
 * Fill DB-default columns so an offline-created event renders through the same
 * components as a server row (lists, badges, detail header). `values` are exactly
 * the columns the queued INSERT will send; everything else takes the DB's default.
 */
export function materializeEventRow(
  op: { id: string; values: Partial<EventRow> },
  nowIso: string
): EventRow {
  return {
    tenant_id: "",
    group_id: "",
    name: "",
    event_date: null,
    venue: null,
    event_type: "idol",
    show_start_time: null,
    hard_out_time: null,
    status: "draft",
    notes: null,
    map_url: null,
    costume_theme: null,
    share_token: null,
    share_expires_at: null,
    deadline: null,
    deadline_note: null,
    last_run_seconds: null,
    last_run_at: null,
    is_template: false,
    is_practice: false,
    created_by: null,
    created_at: nowIso,
    updated_at: nowIso,
    ...op.values,
    id: op.id,
  } as EventRow;
}

/** Thai one-liner for a queued/parked op (status chip + conflict list). */
export function describeOp(op: NewMgmtOp): string {
  const name =
    op.kind === "event.create" ? op.values.name : op.kind === "event.update" ? op.patch.name : null;
  const label =
    typeof name === "string" && name.trim() ? `“${name.trim()}”` : `งาน #${op.id.slice(0, 8)}`;
  if (op.kind === "event.create") return `สร้าง${label}`;
  if (op.kind === "event.update") return `แก้ไข${label}`;
  return `ลบ${label}`;
}

/**
 * Is this write failure a NETWORK failure (queue it and sync later) rather than a
 * real rejection (RLS / validation / constraint — surface it, never queue)?
 * supabase-js doesn't throw on network loss; it resolves with an error whose
 * message wraps the fetch failure, so we classify by message. `onLine` false is
 * always queueable (navigator already knows we're offline).
 */
export function isQueueableWriteError(
  message: string | null | undefined,
  onLine: boolean
): boolean {
  if (!onLine) return true;
  if (!message) return false;
  return /failed to fetch|fetch failed|load failed|network|err_internet|err_network|err_connection|timed? ?out|abort/i.test(
    message
  );
}

/** Client-minted uuid PK for an offline-created event (stable id, no remap). */
export function newEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for any runtime without crypto.randomUUID (kept uuid-shaped).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
