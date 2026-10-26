// 2026-10-27 hunt (showrun-1). The caller's DIRECT write had no bound.
//
// apply() already bounded the clear-the-way flush at 4 s, but the plain online press -
// the UPDATE itself - was awaited unbounded, and supabase-js has no fetch timeout. On
// venue wifi that has associated but has no upstream (navigator.onLine stays TRUE,
// nothing ever answers) the press was neither committed nor queued: `busy` held every
// dock key disabled, inFlightRef swallowed every จบ + ต่อไป, and a reload lost the press
// - for as long as the browser took to give up on the socket (iOS ~60 s, Android minutes).
// Now the write races an 8 s deadline (CALLER_WRITE_TIMEOUT_MS) and, past it, the press
// is queued like any other offline press. The cut write's late answer is never read.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { flushRunSeqOutbox, listRunSeqOps, RUNSEQ_QUEUED_MESSAGE } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
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

const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const DATE = "2026-10-27";
const T0 = "2026-10-27T11:00:00.000Z";
/** The caller's deadline for its own write (CALLER_WRITE_TIMEOUT_MS). */
const DEADLINE_MS = 8000;

function row(over: Partial<RunSeqLive> & { id: string }): RunSeqLive {
  return {
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
    ...over,
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
let server: RunSeqLive[];
/** true = the venue link: associated, no upstream - an UPDATE never answers */
let blackHole: boolean;
/** the answers the black hole swallowed, for a test to deliver late */
let swallowed: ((answer: ReturnType<typeof ok>) => void)[];

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  localStorage.clear();
  vi.clearAllMocks();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: T0, offset_min: 0 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei" }),
  ];
  blackHole = true;
  swallowed = [];
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (call.verb === "update") {
      if (blackHole) return new Promise((resolve) => swallowed.push(resolve));
      const id = call.eq.id as string;
      const r = server.find((x) => x.id === id);
      if (!r) return ok([]);
      Object.assign(r, call.values as object);
      return ok([{ id }]);
    }
    return ok(server.map((r) => ({ ...r })));
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function caller() {
  return (
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={server.map((r) => ({ ...r }))} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

/** Press จบ + ต่อไป into the black hole and let the deadline pass (fake setTimeout). */
async function pressIntoTheBlackHole() {
  const nextKey = await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    fireEvent.click(nextKey);
  });
  // slow still gets its chance: a moment before the deadline the press is still out
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
  });
  expect(screen.getByRole("button", { name: /เลื่อนคิว \+1 นาที/ })).toBeDisabled();
  expect(screen.queryByText(/ค้างซิงค์/)).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  vi.useRealTimers();
}

describe("a press on venue wifi that never answers", () => {
  it("is queued at the deadline, whole, and the dock comes back", async () => {
    render(caller());
    await pressIntoTheBlackHole();

    // the press is safe on this device - both rows of it, as one press
    await waitFor(async () => expect((await listRunSeqOps()).map((o) => o.rowId).sort()).toEqual(["A", "B"]));
    const ops = await listRunSeqOps();
    const byRow = Object.fromEntries(ops.map((o) => [o.rowId, o]));
    expect(byRow.A.patch.status).toBe("done");
    expect(byRow.A.expect).toEqual({ status: "live" });
    expect(byRow.B.patch.status).toBe("live");
    expect(byRow.B.expect).toEqual({ status: "pending" });
    expect(byRow.A.presses).toEqual(byRow.B.presses);
    expect(await screen.findByText(/ค้างซิงค์ 2 รายการ/)).toBeInTheDocument();
    expect(h.toast.success).toHaveBeenCalledWith(RUNSEQ_QUEUED_MESSAGE, { id: "runseq-offline-queued" });

    // ...and the operator can keep calling the show on the board that press left
    expect(screen.getByRole("button", { name: /เลื่อนคิว \+1 นาที/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /จบงาน/ })).not.toBeDisabled(); // B is the last act
  });

  it("the cut write's late answer is never read, and the write gate came down exactly once", async () => {
    render(caller());
    await pressIntoTheBlackHole();
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    supa.query.clearCalls();

    // the abandoned request answers after all - "0 rows" (it raced and lost). Read, it
    // would be judged a lost race: a re-read of the rows (writeWasDenied) and a toast
    // telling the operator another device moved the board.
    expect(swallowed).toHaveLength(2);
    await act(async () => {
      for (const answer of swallowed) answer(ok([]));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(supa.calls.filter((c) => c.filters.some((f) => f.op === "in"))).toHaveLength(0);
    expect(h.toast.info).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();

    // The link is back: the queue lands and the board re-reads.
    blackHole = false;
    await act(async () => {
      await flushRunSeqOutbox();
    });
    expect(server.map((r) => `${r.id}:${r.status}`)).toEqual(["A:done", "B:live"]);
    await waitFor(() => expect(screen.queryByText(/ค้างซิงค์/)).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50)); // the shrink's re-read settles
    });

    // A gate released twice sits at -1, and the next press's write would no longer hold
    // back a refetch: a broadcast during it reads the board BEFORE the write and lands on
    // top of it. Held at 1 it is deferred until the write settles.
    const held = supa.defer("run_sequence"); // the +1's UPDATE
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เลื่อนคิว \+1 นาที/ }));
    });
    await waitFor(() => expect(supa.query.pending().some((c) => c.verb === "update")).toBe(true));
    supa.query.clearCalls();
    await act(async () => {
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "other-device" });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(supa.callsTo("run_sequence", "select")).toHaveLength(0);
    await act(async () => {
      held.resolve(ok([{ id: "B" }]));
      await new Promise((r) => setTimeout(r, 50));
    });
    // ...and once it settled, the deferred read went out
    expect(supa.callsTo("run_sequence", "select").length).toBeGreaterThan(0);
  });
});
