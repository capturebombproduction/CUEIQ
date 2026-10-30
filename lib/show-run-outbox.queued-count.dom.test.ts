// What the sign-out prompt and the desktop login notice count (2026-10-30, hunt 11).
//
// countQueuedShowRunWork counted every record of the running-order store - parked ones too.
// A parked press (conflict: true) is never replayed: it waits for someone to decide on its
// board (ทิ้ง). Counted, both questions promised "ส่งขึ้นเมื่อบัญชีเดิมเข้าสู่ระบบ" for a press
// that never goes up, on every sign-out and every login screen, for as long as it stayed
// parked (and a parked press from last week's show stays until someone taps ทิ้ง).
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps } from "@/lib/run-order-outbox";
import { countQueuedShowRunWork, enqueue } from "@/lib/show-run-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  const supa = makeSupabaseFake({ session: makeSession() });
  // the board moved: r2 is pending on the server, so a press that expected it live parks
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (call.verb === "update") return ok([]);
    const r = { id: "r2", status: "pending", actual_start: null };
    return ok(call.terminal === "maybeSingle" ? r : [r]);
  });
  h.supa = supa;
});

const press = (rowId: string, expectStatus: string) =>
  enqueueRunSeq({
    rowId,
    festival: "Ichiban",
    patch: { status: "live" },
    expect: { status: expectStatus },
    label: "เริ่ม",
    queuedAt: Date.now(),
    presses: [`p-${rowId}`],
  });

describe("countQueuedShowRunWork counts only what a sign-in will send", () => {
  it("a parked press is not counted", async () => {
    await press("r2", "live");
    await flushRunSeqOutbox();
    const ops = await listRunSeqOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].conflict).toBe(true);
    expect(await countQueuedShowRunWork()).toBe(0);
  });

  it("a waiting press and a queued run time still are, beside a parked one", async () => {
    await press("r2", "live");
    await flushRunSeqOutbox(); // parked
    await press("r3", "pending"); // waiting (not flushed)
    await enqueue({ kind: "event_last_run", eventId: "ev1", seconds: 754, at: 1_754_000_000_000 });
    expect(await countQueuedShowRunWork()).toBe(2);
  });
});
