// A press on a row whose EARLIER press parked (2026-10-27, hunt 6).
//
// Two controllers. Desktop Y goes offline and presses จบ + ต่อไป (A → B); a phone on 4G
// does the same. Y's wifi comes back for a moment and Y's press parks - correctly: the
// red panel, the board re-reads and shows B live. Mid-show nobody taps ทิ้ง. The wifi
// drops again, B's set ends, and Y presses จบ + ต่อไป (B → C) on the board the server
// holds. That press used to be folded INTO B's parked op (mergeOp kept its `conflict` and
// its stale precondition), so it parked the moment it was queued, and through the shared
// press id it took C's start into the park as well: back online, every device kept B on
// stage while C played. Online the very same press is a direct write and lands.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import {
  discardRunSeqOp,
  enqueueRunSeq,
  flushRunSeqOutbox,
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

const T_A = "2026-10-27T12:00:00.000Z"; // A started (both devices saw this)
const T_X = "2026-10-27T12:20:00.000Z"; // the phone: จบ + ต่อไป (A → B)
const T_Y1 = "2026-10-27T12:21:00.000Z"; // Y offline: จบ + ต่อไป (A → B) - parks
const T_Y2 = "2026-10-27T12:45:00.000Z"; // Y offline again: จบ + ต่อไป (B → C)

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
const base = { festival: "Fest · 2026-10-27", topic: "runorder:t:2026-10-27:Fest" };

function useServer(rows: Row[]) {
  server = rows;
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", serverTable(server));
  h.supa = supa;
}

const byRow = async () => Object.fromEntries((await listRunSeqOps()).map((o) => [o.rowId, o])) as Record<string, RunSeqOp>;

/** Y's first press - parked by a flush against the phone's A → B. */
async function parkYsFirstPress() {
  await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "A", label: "A", patch: { status: "done", actual_end: T_Y1 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "B", label: "B", patch: { status: "live", actual_start: T_Y1, offset_min: 1 }, expect: { status: "pending" } });
  await flushRunSeqOutbox();
  const ops = await byRow();
  expect(ops.A.conflict && ops.B.conflict).toBe(true);
}

/** Y's second press, exactly as EventLiveCaller.queueOffline enqueues it. */
async function queueYsSecondPress() {
  await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "B", label: "B", patch: { status: "done", actual_end: T_Y2 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "C", label: "C", patch: { status: "live", actual_start: T_Y2, offset_min: 0 }, expect: { status: "pending" } });
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
});

describe("a press on a row whose earlier press parked", () => {
  it("lands when the wifi is back, like the same press online - and the parked sibling waits for a human", async () => {
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T_A, actual_end: T_X, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: T_X, offset_min: 0 },
      pending("C", 3),
    ]);
    await parkYsFirstPress();

    await queueYsSecondPress();
    // queued, not parked: the ค้างซิงค์ chip counts it and the overlay keeps it on the board
    const queued = await byRow();
    expect(queued.B.conflict).toBeFalsy();
    expect(queued.C.conflict).toBeFalsy();

    const res = await flushRunSeqOutbox();

    expect(server.find((r) => r.id === "B")).toMatchObject({ status: "done", actual_end: T_Y2 });
    expect(server.find((r) => r.id === "C")).toMatchObject({ status: "live", actual_start: T_Y2 });
    // nothing of the parked press was replayed: B's start is still the phone's
    expect(server.find((r) => r.id === "B")!.actual_start).toBe(T_X);
    expect(server.find((r) => r.id === "A")!.actual_end).toBe(T_X);
    // A - the half of the parked press nobody pressed over - is still on the red panel
    const left = await byRow();
    expect(Object.keys(left)).toEqual(["A"]);
    expect(left.A.conflict).toBe(true);
    expect(res).toMatchObject({ flushed: 2, conflicts: 1, remaining: 1 });
  });

  it("is still a compare-and-swap: when the board moved again it parks on its own, whole", async () => {
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T_A, actual_end: T_X, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: T_X, offset_min: 0 },
      pending("C", 3),
    ]);
    await parkYsFirstPress();
    await queueYsSecondPress();
    // ...and the phone ended B and started C first
    Object.assign(server.find((r) => r.id === "B")!, { status: "done", actual_end: "2026-10-27T12:44:00.000Z" });
    Object.assign(server.find((r) => r.id === "C")!, { status: "live", actual_start: "2026-10-27T12:44:00.000Z", offset_min: 0 });

    await flushRunSeqOutbox();

    // nothing overwritten, and every row a human must look at is on the panel
    expect(server.find((r) => r.id === "C")!.actual_start).toBe("2026-10-27T12:44:00.000Z");
    const left = await byRow();
    expect(Object.keys(left).sort()).toEqual(["A", "B", "C"]);
    expect(Object.values(left).every((o) => o.conflict)).toBe(true);
    expect(left.B.patch).toEqual({ status: "done", actual_end: T_Y2 }); // the newer press, named on the panel
  });

  it("a ทิ้ง offered for the old parked op does not take the newer press that replaced it", async () => {
    useServer([
      { ...pending("A", 1), status: "done", actual_start: T_A, actual_end: T_X, offset_min: 0 },
      { ...pending("B", 2), status: "live", actual_start: T_X, offset_min: 0 },
      pending("C", 3),
    ]);
    await parkYsFirstPress();
    await queueYsSecondPress();

    await discardRunSeqOp("B"); // a panel rendered before the press, tapped after it

    const left = await byRow();
    expect(left.B).toMatchObject({ patch: { status: "done", actual_end: T_Y2 } });
    expect(left.B.conflict).toBeFalsy();
    // a parked one still goes
    await discardRunSeqOp("A");
    expect((await byRow()).A).toBeUndefined();
  });
});
