// 2026-10-27 hunt (showrun). A regression of c4388cf + 4fdb9a6: refetch() now reads the queue BEFORE the rows and then
// setQueued(ops) with that early read. apply() bumps refetchSeqRef before every enqueue,
// so a refetch that straddles an apply() press is dropped - but ดึง buffer's DRAINS are
// queued by takeBuffer() AFTER apply() returned "queued", with no seq bump. A refetch
// already in flight (release() fires the one a broadcast deferred) then lands its
// pre-drain queue read over the fresh one: the drains vanish from the overlay and the
// board shows the spent buffers again.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, offline, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { enqueueRunSeq, listRunSeqOps } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "@/components/event/event-live-caller";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const DATE = "2026-10-26";
const T0 = "2026-10-26T11:00:00.000Z";

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
let slowSelects = false;

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: T0, offset_min: 9 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei", buffer_seconds: 300 }),
    row({ id: "C", sort_order: 3, title: "เกมชิงรางวัล", buffer_seconds: 300 }),
  ];
  slowSelects = false;
  // venue wifi that reads but whose writes do not get through (the flush cannot clear A)
  supa.setTable("run_sequence", async (call) => {
    if (call.verb === "update") return offline();
    const answer = server.map((r) => ({ ...r }));
    if (slowSelects) await new Promise((r) => setTimeout(r, 150)); // the read's round trip
    return ok(answer);
  });
});

describe("ดึง buffer's queued drains stay on the board", () => {
  it("a refetch in flight while the drains queue does not take them off the overlay", async () => {
    // an earlier +1 on the live act is still queued on this device
    await enqueueRunSeq({
      rowId: "A",
      festival: `${FEST} · ${DATE}`,
      label: "วงเปิด",
      queuedAt: 1,
      presses: ["p0"],
      topic: runOrderTopic(TENANT, DATE, FEST),
      patch: { offset_min: 10 },
      expect: { status: "live", offset_min: 9 },
    });
    render(
      <AccountPanelProvider>
        <ConfirmProvider>
          <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={server.map((r) => ({ ...r }))} canControl />
        </ConfirmProvider>
      </AccountPanelProvider>
    );
    await screen.findByText(/ค้างซิงค์ 1 รายการ/);
    expect(screen.getAllByText(/buffer 5น\./)).toHaveLength(2);

    slowSelects = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ดึง buffer/ }));
      // another staff device's broadcast arrives while this press is being written
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "other-device" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    // the queue holds the drift AND both drains (B and C at 0 s)
    const ops = await listRunSeqOps();
    expect(ops.map((o) => `${o.rowId}:${o.patch.buffer_seconds ?? "-"}`).sort()).toEqual(["A:-", "B:0", "C:0"]);
    // ...so the board must show them spent - no "buffer 5น." left on B or C
    expect(screen.queryAllByText(/buffer 5น\./)).toHaveLength(0);
    expect(screen.getByText(/ค้างซิงค์ 3 รายการ/)).toBeInTheDocument();
  });
});
