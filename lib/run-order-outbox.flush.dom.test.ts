// ---------------------------------------------------------------------------
// A PRESS WHOSE ANSWER WAS LOST IS NOT SOMEONE ELSE'S CONFLICT.
//
// The show-caller presses "เริ่ม" on venue wifi; the UPDATE reaches the server and
// commits, and the response never comes back. The press is queued (a network error
// is not a conflict), and on the replay its precondition no longer holds — because
// the server already says exactly what the press wrote. The flush used to read
// "0 rows, row still there" as "someone else drove the board" and park it: a red
// conflict panel at a festival, for the operator's own press. Now the probe reads
// the patched columns back, and a row that already holds them is this press, done.
//
// `.dom.test.ts`: the queue is IndexedDB (fake-indexeddb under jsdom).
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps, type RunSeqOp } from "@/lib/run-order-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

const START = "2026-10-24T12:00:00.000Z";
const press: RunSeqOp = {
  rowId: "row-1",
  festival: "La famiglia · 2026-10-24",
  patch: { status: "live", actual_start: START },
  expect: { status: "next" },
  label: "เริ่ม: วง Seishin Kakumei",
  queuedAt: 1000,
};

let supa: SupabaseFake;

/** The conditional UPDATE matches nothing; the probe answers with `row`. */
function serverHolds(row: Record<string, unknown> | null) {
  supa.setTable("run_sequence", (call) => (call.verb === "update" ? ok([]) : ok(row)));
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

describe("run-order replay after a lost response", () => {
  it("the row already holds the press → done, not parked", async () => {
    await enqueueRunSeq(press);
    // what PostgREST hands back for the timestamp the press sent as ….000Z
    serverHolds({ id: "row-1", status: "live", actual_start: "2026-10-24T12:00:00+00:00" });

    const res = await flushRunSeqOutbox();
    expect(res).toEqual({ flushed: 1, conflicts: 0, remaining: 0 });
    expect(await listRunSeqOps()).toEqual([]);
    // the probe asked for the patched columns, and only those
    const probe = supa.callsTo("run_sequence", "select")[0];
    expect(probe.columns).toBe("id, status, actual_start");
  });

  it("someone else really moved the row → still parked for a human", async () => {
    await enqueueRunSeq(press);
    serverHolds({ id: "row-1", status: "done", actual_start: "2026-10-24T11:40:00+00:00" });

    const res = await flushRunSeqOutbox();
    expect(res.conflicts).toBe(1);
    expect((await listRunSeqOps())[0].conflict).toBe(true);
  });

  it("the row is gone → dropped, as before", async () => {
    await enqueueRunSeq(press);
    serverHolds(null);

    const res = await flushRunSeqOutbox();
    // (a dropped op counts as flushed: it has left the queue, which is what the chip counts)
    expect(res).toEqual({ flushed: 1, conflicts: 0, remaining: 0 });
  });
});

// ---------------------------------------------------------------------------
// …AND STILL NOT WHEN A LATER PRESS MERGED INTO IT (2026-10-25).
//
// เริ่ม on row A commits, the answer is lost → queued (expect pending). Still offline,
// the operator presses จบ: it merges into A's op (first expect, latest columns). On
// replay the UPDATE (where status = pending) matches nothing, and the merged patch
// (status done) is not what the row holds (live, from the FIRST press) - so the
// operator's own two presses were parked as someone else's conflict. Now an op whose
// row holds an EARLIER version of its patch rebases its expect onto that state and
// retries once.
// ---------------------------------------------------------------------------
describe("run-order replay: a lost answer, then a press merged into the same row", () => {
  const T1 = "2026-10-24T12:00:00.000Z";
  const T2 = "2026-10-24T12:04:30.000Z";
  const startA: RunSeqOp = {
    rowId: "row-A",
    festival: "La famiglia · 2026-10-24",
    patch: { status: "live", actual_start: T1, offset_min: 2 },
    expect: { status: "pending" },
    label: "เริ่ม: วง A",
    queuedAt: 1000,
  };
  const endA: RunSeqOp = {
    rowId: "row-A",
    festival: "La famiglia · 2026-10-24",
    patch: { status: "done", actual_end: T2 },
    expect: { status: "live" },
    label: "จบ: วง A",
    queuedAt: 2000,
  };

  /** A server row the conditional UPDATE really is judged against. `lose` = the next
   *  UPDATE commits but its answer never comes back. `moveAfterProbe` = someone else
   *  writes the row between our probe and our next UPDATE. */
  function server(row: Record<string, unknown>, opts: { lose?: number; moveAfterProbe?: Record<string, unknown> } = {}) {
    let lose = opts.lose ?? 0;
    const updates: { patch: unknown; filters: unknown[] }[] = [];
    supa.setTable("run_sequence", (call) => {
      if (call.verb === "select") {
        const answer = ok({ ...row });
        if (opts.moveAfterProbe) Object.assign(row, opts.moveAfterProbe);
        return answer;
      }
      if (call.verb !== "update") return ok([]);
      updates.push({ patch: call.values, filters: call.filters.filter((f) => f.column !== "id") });
      const holds = call.filters.every((f) => {
        const have = row[f.column];
        if (f.op === "is") return have == null;
        if (f.op === "eq") return String(have) === String(f.value);
        return true;
      });
      if (holds) Object.assign(row, call.values as Record<string, unknown>);
      if (lose > 0) {
        lose--;
        return { data: null, error: { message: "TypeError: Failed to fetch" }, status: 0 };
      }
      return ok(holds ? [{ id: row.id }] : []);
    });
    return { row, updates };
  }

  it("the row holds the first press → rebased onto it, retried once, lands; nothing parked", async () => {
    await enqueueRunSeq(startA);
    await enqueueRunSeq(endA);
    const s = server({ id: "row-A", status: "live", actual_start: "2026-10-24T12:00:00+00:00", actual_end: null, offset_min: 2 });

    const res = await flushRunSeqOutbox();

    expect(res).toEqual({ flushed: 1, conflicts: 0, remaining: 0 });
    expect(s.row.status).toBe("done");
    expect(s.row.actual_end).toBe(T2);
    expect(s.updates).toHaveLength(2);
    // the retry expects what the first press left on the server
    expect(s.updates[1].filters).toEqual([{ op: "eq", column: "status", value: "live" }]);
  });

  it("an earlier REPLAY whose answer was lost, then another press → the same", async () => {
    await enqueueRunSeq(startA);
    await enqueueRunSeq({ ...startA, patch: { offset_min: 4 }, expect: { status: "live", offset_min: 2 }, label: "+2 นาที", queuedAt: 1500 });
    const s = server({ id: "row-A", status: "pending", actual_start: null, actual_end: null, offset_min: null }, { lose: 1 });
    // flush 1: the merged start+nudge commits, its answer is lost → stays queued
    expect((await flushRunSeqOutbox()).remaining).toBe(1);
    expect(s.row).toMatchObject({ status: "live", offset_min: 4 });
    // still offline-ish: จบ merges in
    await enqueueRunSeq(endA);

    const res = await flushRunSeqOutbox();

    expect(res).toEqual({ flushed: 1, conflicts: 0, remaining: 0 });
    expect(s.row).toMatchObject({ status: "done", actual_end: T2, offset_min: 4 });
  });

  it("a row someone else moved is still parked, with no retry", async () => {
    await enqueueRunSeq(startA);
    await enqueueRunSeq(endA);
    const s = server({ id: "row-A", status: "live", actual_start: "2026-10-24T11:58:00+00:00", actual_end: null, offset_min: 0 });

    const res = await flushRunSeqOutbox();

    expect(res.conflicts).toBe(1);
    expect((await listRunSeqOps())[0].conflict).toBe(true);
    expect(s.updates).toHaveLength(1);
  });

  it("retries ONCE: a row that moves between the probe and the retry is parked", async () => {
    await enqueueRunSeq(startA);
    await enqueueRunSeq(endA);
    const s = server(
      { id: "row-A", status: "live", actual_start: "2026-10-24T12:00:00+00:00", actual_end: null, offset_min: 2 },
      { moveAfterProbe: { status: "done", actual_end: "2026-10-24T12:03:00+00:00" } }
    );

    const res = await flushRunSeqOutbox();

    expect(res.conflicts).toBe(1);
    expect(s.updates).toHaveLength(2);
    expect(s.row.actual_end).toBe("2026-10-24T12:03:00+00:00"); // theirs, not overwritten
  });
});
