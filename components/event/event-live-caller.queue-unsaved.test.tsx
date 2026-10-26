// A press the device could not store in its queue (2026-10-27, hunt 6).
//
// enqueueRunSeq swallowed every storage failure (a full disk, quota, a broken IndexedDB)
// and queueOffline answered "queued" regardless, so the operator read "ออฟไลน์อยู่ —
// คิวบนเครื่องนี้เดินต่อแล้ว จะซิงค์ให้เมื่อเน็ตกลับ" about a press that existed on this
// screen only: the next re-read wiped it and nothing ever replayed it. Now the queue says
// whether it stored the press, and the board says when it did not.
//
// Also here: the start a press queues carries the plan its drift was read against
// (RunSeqOp.planBasis) - the replay needs it when staff re-plan the act meanwhile
// (lib/run-order-outbox.replan.dom.test.ts).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, offline, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { listRunSeqOps, RUNSEQ_QUEUED_MESSAGE } from "@/lib/run-order-outbox";
import { EventLiveCaller, type RunSeqLive } from "@/components/event/event-live-caller";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

function row(over: Partial<RunSeqLive> & { id: string }): RunSeqLive {
  return {
    sort_order: 1, title: "", kind: "band", planned_start: null, planned_end: null,
    buffer_seconds: 0, linked_event_id: null, actual_start: null, actual_end: null,
    status: "pending", offset_min: null, ...over,
  };
}
function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

let supa: SupabaseFake;
const server = [
  row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: "2026-10-27T11:00:00.000Z", offset_min: 0, planned_start: "18:00:00" }),
  row({ id: "B", sort_order: 2, title: "Seishin Kakumei", planned_start: "18:40:00" }),
];

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  vi.clearAllMocks();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  // venue wifi gone: every write fails at the transport
  supa.setTable("run_sequence", (call: RecordedCall) => (call.verb === "update" ? offline() : ok(server)));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function board() {
  return (
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId="t1" eventName="Fest" eventDate="2026-10-27" eventId="ev-1" initial={server} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

async function pressNext() {
  const nextKey = await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
  await act(async () => {
    fireEvent.click(nextKey);
  });
}

describe("a press the queue could not store", () => {
  it("is never announced as queued: the board says it is kept nowhere", async () => {
    render(board());
    await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
    // the device's storage refuses every write to the queue's database from here on
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    await pressNext();

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("เก็บการกดไว้ในเครื่องไม่สำเร็จ", expect.anything()));
    expect(h.toast.success).not.toHaveBeenCalledWith(RUNSEQ_QUEUED_MESSAGE, expect.anything());
    // and the dock comes back for the re-press
    await waitFor(() => expect(screen.getByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ })).not.toBeDisabled());
  });

  it("(control) a press the queue did store is announced as queued, as before", async () => {
    render(board());
    await pressNext();

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(RUNSEQ_QUEUED_MESSAGE, expect.anything()));
    expect(h.toast.error).not.toHaveBeenCalled();
  });
});

describe("the start a press queues", () => {
  it("carries the planned_start its drift was read against; the end it queues carries none", async () => {
    render(board());
    await pressNext();
    await waitFor(async () => expect((await listRunSeqOps()).length).toBe(2));

    const ops = Object.fromEntries((await listRunSeqOps()).map((o) => [o.rowId, o]));
    expect(ops.B.planBasis).toBe("18:40:00");
    expect(ops.B.patch.status).toBe("live");
    expect(ops.A.planBasis).toBeUndefined();
  });

  it("a start with no plan (drift carried over, not read off the plan) says so", async () => {
    server[1] = { ...server[1], planned_start: null };
    try {
      render(board());
      await pressNext();
      await waitFor(async () => expect((await listRunSeqOps()).length).toBe(2));
      const ops = Object.fromEntries((await listRunSeqOps()).map((o) => [o.rowId, o]));
      expect(ops.B.planBasis).toBeNull();
    } finally {
      server[1] = { ...server[1], planned_start: "18:40:00" };
    }
  });
});
