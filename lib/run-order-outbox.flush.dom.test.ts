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
