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
//
// NOT here (deliberately, still GATED on พี่ confirming the read-cache works on the
// packaged .exe): the IndexedDB queue I/O (mirror lib/show-run-outbox.ts), the
// loader-overlay + write-path wiring, and the setlist/schedule/mic/lineup ops. Those
// touch the live desktop write path, so they wait for real-device testing. This pure
// core is unit-tested (lib/mgmt-outbox.test.ts) and design-stable, so wiring is fast
// once the gate lifts.
import type { EventRow } from "@/lib/types";

/**
 * A queued offline management write. `seq` is a per-device monotonic counter so a
 * create-then-edits replays in the exact order it was made. `base` is the epoch-ms
 * `updated_at` of the row the edit was made against — null when unknown; used by
 * shouldApplyOnFlush to detect "the server changed under me".
 */
export type MgmtOp =
  | { kind: "event.create"; seq: number; id: string; values: Partial<EventRow> }
  | { kind: "event.update"; seq: number; id: string; patch: Partial<EventRow>; base: number | null }
  | { kind: "event.delete"; seq: number; id: string; base: number | null };

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
export function shouldApplyOnFlush(op: MgmtOp, serverUpdatedAtMs: number | null): boolean {
  if (op.kind === "event.create") return true;
  if (op.base == null || serverUpdatedAtMs == null) return true;
  return serverUpdatedAtMs <= op.base;
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
