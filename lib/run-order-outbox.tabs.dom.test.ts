// ---------------------------------------------------------------------------
// A PRESS ANOTHER TAB SETTLED IS NOT SENT AGAIN (2026-10-30, hunt 12).
//
// Every web tab runs its own pass over one IndexedDB queue, each from the list it made when
// it began. What used to go wrong: tab A landed a press and removed it, the operator took it
// back online (the row held the op's precondition again), and tab B, still working through
// its old list, found the op gone and sent its stale copy - the compare-and-swap matched, and
// the undo was silently reversed. A press whose first row left the store could also park the
// rest of the press, when that row had moved on.
//
// `.dom.test.ts`: the queue is IndexedDB (fake-indexeddb under jsdom).
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps, type RunSeqOp } from "@/lib/run-order-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** What the OTHER tab's removal does: the op leaves the shared store. */
function otherTabRemoves(rowId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cueiq-outbox");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("runseq", "readwrite");
      tx.objectStore("runseq").delete(rowId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
}

const op = (rowId: string, over: Partial<RunSeqOp> = {}): RunSeqOp => ({
  rowId,
  festival: "F · 2026-10-31",
  patch: { offset_min: 5 },
  expect: { offset_min: 0 },
  label: `+5: ${rowId}`,
  queuedAt: 1,
  presses: [`press-${rowId}`],
  ...over,
});

let supa: SupabaseFake;
const updatesSent = () => supa.callsTo("run_sequence", "update").map((c) => String(c.eq.id));

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

describe("two tabs replay one queue", () => {
  it("a press another tab settled while this pass was on an earlier row is not sent from the old list", async () => {
    await enqueueRunSeq(op("row-1"));
    await enqueueRunSeq(op("row-2"));
    supa.setTable("run_sequence", async (call) => {
      if (call.verb !== "update") return ok(null);
      const id = String(call.eq.id);
      // this tab's first write is on the wire: tab A lands row-2 and removes it, the
      // operator takes that +5 back - the row holds 0 again, so a resend WOULD match
      if (id === "row-1") await otherTabRemoves("row-2");
      return ok([{ id }]);
    });

    const res = await flushRunSeqOutbox();

    expect(updatesSent()).toEqual(["row-1"]);
    expect(res).toMatchObject({ flushed: 1, conflicts: 0, remaining: 0 });
  });

  it("one row of a two-row press settled and moved on elsewhere does not park the row still queued", async () => {
    const press = { presses: ["p1"] };
    await enqueueRunSeq(op("row-1", { patch: { status: "done" }, expect: { status: "live" }, ...press }));
    await enqueueRunSeq(op("row-2", { patch: { status: "live" }, expect: { status: "next" }, ...press }));
    supa.setTable("run_sequence", async (call) => {
      if (call.verb === "update") return ok([{ id: call.eq.id }]);
      return ok([
        { id: "row-1", status: "pending" }, // holds neither what the op expects nor its patch
        { id: "row-2", status: "next" },
      ]);
    });
    // after this pass made its list (the session check comes next): tab A has landed the
    // first row, removed its op, and the row has moved on since
    let removed = false;
    supa.auth.getSession.mockImplementation(async () => {
      if (!removed) {
        removed = true;
        await otherTabRemoves("row-1");
      }
      return { data: { session: makeSession() }, error: null };
    });

    const res = await flushRunSeqOutbox();

    expect(updatesSent()).toEqual(["row-2"]);
    expect(res).toMatchObject({ conflicts: 0, remaining: 0 });
    expect(await listRunSeqOps()).toEqual([]);
  });

  it("a queue that cannot be read mid-pass sends nothing from the old list and keeps the press", async () => {
    await enqueueRunSeq(op("row-1"));
    await enqueueRunSeq(op("row-2"));
    const realOpen = indexedDB.open.bind(indexedDB);
    let failing = false;
    const spy = vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<IDBFactory["open"]>) => {
      if (failing) throw new Error("storage went away");
      return realOpen(...args);
    });
    supa.setTable("run_sequence", async (call) => {
      if (call.verb !== "update") return ok(null);
      failing = true; // from the first row's answer on, the store is unreadable
      return ok([{ id: call.eq.id }]);
    });
    try {
      await flushRunSeqOutbox().catch(() => {});
    } finally {
      spy.mockRestore();
    }
    expect(updatesSent()).toEqual(["row-1"]);
    expect((await listRunSeqOps()).map((o) => o.rowId)).toContain("row-2");
  });
});
