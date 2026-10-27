// A press the operator threw away while the flush was still judging it (2026-10-27,
// hunt 6, Argon on ee63ea6).
//
// doFlush decides to PARK a press only after a network read (precheckPress), and writes
// the park at the very end (parkRunSeq). parkRunSeq re-read each record and parked
// `stored ?? o` - so a record that was GONE by then, because the operator tapped ทิ้ง on
// the red panel during that read (or another tab's flush landed it), was written back
// from the flush's own snapshot: the press the operator had just discarded reappeared on
// the panel, and a landed one came back as a conflict nobody caused. A record that is no
// longer there is never re-created now.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { discardRunSeqOp, enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps, type RunSeqOp } from "@/lib/run-order-outbox";

type Row = Record<string, unknown> & { id: string };

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

/** Write straight into the queue's store, as ANOTHER TAB of this browser does. */
function inOtherTab(fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cueiq-outbox", 2);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("runseq", "readwrite");
      fn(tx.objectStore("runseq"));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// The phone drove the board while this device was offline: A done, B live.
const server: Row[] = [
  { id: "A", sort_order: 1, status: "done", actual_start: "2026-10-27T12:00:00.000Z", actual_end: "2026-10-27T12:20:00.000Z", offset_min: 0, buffer_seconds: 0 },
  { id: "B", sort_order: 2, status: "live", actual_start: "2026-10-27T12:20:00.000Z", actual_end: null, offset_min: 0, buffer_seconds: 0 },
];
/** the precheck's read, held open until the test lets it answer */
let releasePrecheck: (() => void) | null;

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  releasePrecheck = null;
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", (call: RecordedCall) => {
    const rows = server.map((r) => ({ ...r }));
    if (call.verb === "select" && call.filters.some((f) => f.op === "in")) {
      return new Promise((resolve) => {
        releasePrecheck = () => resolve(ok(rows));
      });
    }
    return ok(call.terminal === "maybeSingle" ? (rows[0] ?? null) : rows);
  });
  h.supa = supa;
  // this device's offline จบ + ต่อไป (A → B) - built on a board the phone has moved
  const base = { festival: "Fest · 2026-10-27", topic: "runorder:t:2026-10-27:Fest", queuedAt: 1, presses: ["p1"] };
  await enqueueRunSeq({ ...base, rowId: "A", label: "A", patch: { status: "done", actual_end: "2026-10-27T12:21:00.000Z" }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, rowId: "B", label: "B", patch: { status: "live", actual_start: "2026-10-27T12:21:00.000Z", offset_min: 1 }, expect: { status: "pending" } });
});

/** Start a flush and come back once its precheck read is out (boxed: an async function
 *  returning the flush promise itself would wait for it). */
async function precheckInFlight(): Promise<{ flushing: Promise<unknown> }> {
  const flushing = flushRunSeqOutbox();
  for (let i = 0; !releasePrecheck && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  expect(releasePrecheck).not.toBeNull();
  return { flushing };
}

describe("a record that is gone by the time the flush parks its press", () => {
  it("a press thrown away (ทิ้ง) during the flush's read does not come back on the panel", async () => {
    const { flushing } = await precheckInFlight();
    // meanwhile another tab parked it, the panel showed it, and the operator threw it away
    await inOtherTab((store) => {
      for (const id of ["A", "B"]) {
        const get = store.get(id);
        get.onsuccess = () => store.put({ ...(get.result as RunSeqOp), conflict: true }, id);
      }
    });
    await discardRunSeqOp("A");
    await discardRunSeqOp("B");
    expect(await listRunSeqOps()).toEqual([]);

    releasePrecheck!(); // the read answers: the board moved on, so this flush parks the press
    await flushing;

    expect(await listRunSeqOps()).toEqual([]);
  });

  it("a press another tab removed during the read is not written back as a conflict", async () => {
    const { flushing } = await precheckInFlight();
    await inOtherTab((store) => {
      store.delete("A");
      store.delete("B");
    });

    releasePrecheck!();
    await flushing;

    expect(await listRunSeqOps()).toEqual([]);
  });

  it("(control) a record still there is parked whole, as before", async () => {
    const { flushing } = await precheckInFlight();
    releasePrecheck!();
    await flushing;

    const left = await listRunSeqOps();
    expect(left.map((o) => [o.rowId, o.conflict]).sort()).toEqual([
      ["A", true],
      ["B", true],
    ]);
  });
});
