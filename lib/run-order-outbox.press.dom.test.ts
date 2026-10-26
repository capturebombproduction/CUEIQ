// A replayed press lands WHOLE or parks WHOLE (2026-10-26 bug hunt).
//
// "จบ + ต่อไป" is ONE press that writes TWO rows (the live act → done, the next →
// live). The queue used to replay every row as an independent compare-and-swap, so
// when another controller had driven the board meanwhile, the rows that device had
// moved parked - and a row it had not reached yet still read `pending`, so that half
// of the press landed on its own. The festival ended up with TWO acts live, the
// caller showed the first as NOW and offered the act after the second: one act was
// never called.
//
// Scenario: board A live, B/C/D pending. Device Y (desktop at FOH, venue wifi dead)
// presses จบ+ต่อไป twice (A→B, B→C). Meanwhile device X (a phone on 4G) presses it
// once (A→B). Y's network comes back and its queue flushes.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import {
  enqueueRunSeq,
  flushRunSeqOutbox,
  groupRunSeqPresses,
  listRunSeqOps,
  type RunSeqOp,
} from "@/lib/run-order-outbox";

type Row = Record<string, unknown> & { id: string };

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

/** A tiny run_sequence that honours the update's eq/is/in filters (the CAS). */
function serverTable(rows: Row[]) {
  const matches = (r: Row, call: RecordedCall) =>
    call.filters.every((f) =>
      f.op === "eq"
        ? r[f.column] === f.value
        : f.op === "is"
          ? r[f.column] == null
          : f.op === "in"
            ? (f.value as unknown[]).includes(r[f.column])
            : true
    );
  return (call: RecordedCall) => {
    if (call.verb === "update") {
      const hit = rows.filter((r) => matches(r, call));
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    const hit = rows.filter((r) => matches(r, call)).map((r) => ({ ...r }));
    return ok(call.terminal === "maybeSingle" ? (hit[0] ?? null) : hit);
  };
}

const T0 = "2026-10-26T12:00:00.000Z"; // A started (both devices saw this)
const TX = "2026-10-26T12:20:00.000Z"; // X: จบ+ต่อไป (A→B)
const TY1 = "2026-10-26T12:21:00.000Z"; // Y offline: จบ+ต่อไป (A→B)
const TY2 = "2026-10-26T12:40:00.000Z"; // Y offline: จบ+ต่อไป (B→C)

const pending = (id: string, sort_order: number): Row => ({
  id,
  sort_order,
  status: "pending",
  actual_start: null,
  actual_end: null,
  offset_min: null,
  buffer_seconds: 0,
});

let server: Row[];

function useServer(rows: Row[]) {
  server = rows;
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", serverTable(server));
  h.supa = supa;
}

const base = { festival: "Fest · 2026-10-26", topic: "runorder:t:2026-10-26:Fest" };

/** Exactly what EventLiveCaller.queueOffline enqueues for Y's two presses. */
async function queueYsTwoPresses() {
  await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "A", label: "A", patch: { status: "done", actual_end: TY1 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "B", label: "B", patch: { status: "live", actual_start: TY1, offset_min: 1 }, expect: { status: "pending" } });
  await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "B", label: "B", patch: { status: "done", actual_end: TY2 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "C", label: "C", patch: { status: "live", actual_start: TY2, offset_min: 0 }, expect: { status: "pending" } });
}

const live = () => server.filter((r) => r.status === "live").map((r) => r.id);
const parkedRows = async () =>
  (await listRunSeqOps())
    .filter((o) => o.conflict)
    .map((o) => o.rowId)
    .sort();

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
});

describe("the run-order queue replays a press as one unit", () => {
  it("another device drove the board: the whole chain parks, nothing lands, one act stays live", async () => {
    // what the server holds after X's one press
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T0, actual_end: TX, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: TX, offset_min: 0 },
      pending("C", 3),
      pending("D", 4),
    ]);
    await queueYsTwoPresses();

    await flushRunSeqOutbox();

    // C's start was built on B's, which was built on A's end - one unit, parked whole
    expect(await parkedRows()).toEqual(["A", "B", "C"]);
    expect(live()).toEqual(["B"]);
    expect(server.find((r) => r.id === "C")!.status).toBe("pending");
  });

  it("(control) nobody else moved: both presses land, C is the one act live", async () => {
    useServer([
      { ...pending("A", 1), status: "live", actual_start: T0, offset_min: 0 },
      pending("B", 2),
      pending("C", 3),
      pending("D", 4),
    ]);
    await queueYsTwoPresses();

    const res = await flushRunSeqOutbox();

    expect(res).toMatchObject({ flushed: 3, conflicts: 0, remaining: 0 });
    expect(live()).toEqual(["C"]);
    expect(server.map((r) => r.status)).toEqual(["done", "done", "live", "pending"]);
  });

  it("a press built on one that already parked parks too, without being sent", async () => {
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T0, actual_end: TX, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: TX, offset_min: 0 },
      pending("C", 3),
      pending("D", 4),
    ]);
    // an earlier flush parked A↔B; a press made afterwards (B→C) folded into B's record
    await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "A", label: "A", patch: { status: "done", actual_end: TY1 }, expect: { status: "live" }, conflict: true });
    await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1", "p2"], rowId: "B", label: "B", patch: { status: "done", actual_end: TY2 }, expect: { status: "pending" }, conflict: true });
    await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "C", label: "C", patch: { status: "live", actual_start: TY2 }, expect: { status: "pending" } });
    const supa = h.supa as ReturnType<typeof makeSupabaseFake>;

    await flushRunSeqOutbox();

    expect(await parkedRows()).toEqual(["A", "B", "C"]);
    expect(supa.callsTo("run_sequence", "update")).toHaveLength(0);
    expect(live()).toEqual(["B"]);
  });

  it("presses on rows no other press touches still replay on their own", async () => {
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T0, actual_end: TX, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: TX, offset_min: 0 },
      pending("C", 3),
      { ...pending("D", 4), buffer_seconds: 300 },
    ]);
    await queueYsTwoPresses();
    // an unrelated press (another festival's row, or an older record with no press id)
    await enqueueRunSeq({ ...base, queuedAt: 3, rowId: "D", label: "D", patch: { buffer_seconds: 0 }, expect: { status: "pending", buffer_seconds: 300 } });

    await flushRunSeqOutbox();

    expect(await parkedRows()).toEqual(["A", "B", "C"]);
    expect(server.find((r) => r.id === "D")!.buffer_seconds).toBe(0);
  });
});

describe("groupRunSeqPresses", () => {
  const op = (rowId: string, presses: string[] | undefined, over: Partial<RunSeqOp> = {}): RunSeqOp => ({
    rowId,
    festival: "F",
    patch: {},
    expect: {},
    label: rowId,
    queuedAt: 1,
    ...(presses ? { presses } : {}),
    ...over,
  });

  it("joins presses through a row they share, and leaves older records alone", () => {
    const units = groupRunSeqPresses([
      op("C", ["p2"], { queuedAt: 2, patch: { status: "live" } }),
      op("X", undefined),
      op("B", ["p1", "p2"], { patch: { status: "done" } }),
      op("A", ["p1"], { patch: { status: "done" } }),
      op("E", ["p9"]),
    ]);
    expect(units.map((u) => u.map((o) => o.rowId))).toEqual([["B", "A", "C"], ["X"], ["E"]]);
  });

  it("ends a row before it starts the next one inside a press", () => {
    const units = groupRunSeqPresses([
      op("B", ["p1"], { patch: { status: "live" } }),
      op("A", ["p1"], { patch: { status: "done" } }),
    ]);
    expect(units[0].map((o) => o.rowId)).toEqual(["A", "B"]);
  });
});
