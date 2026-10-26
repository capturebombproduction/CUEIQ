// The board and its queue, read in the right order (2026-10-26, ตาที่ 3).
//
// (1) refetch() read the rows and THEN the queue. A flush landing between the two reads
//     gave rows from before it and a queue from after it: the landed press was on
//     neither, the board showed the act it had ended as NOW, and the shrink the flush
//     announced was swallowed (queueCountRef already 0) so no re-read came.
// (2) The shrink check counted every record, parked ones included: a press that PARKED
//     stayed in the store, the count never fell, and the board kept the optimistic rows of
//     a press the server never took.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { enqueueRunSeq, flushRunSeqOutbox } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";

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
const T1 = "2026-10-26T11:30:00.000Z";
const T2 = "2026-10-26T12:00:00.000Z";

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

/** Another tab's flush: the records are gone, and no event reached this window. */
function drainedByAnotherTab(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cueiq-outbox", 2);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("runseq", "readwrite");
      tx.objectStore("runseq").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

let supa: SupabaseFake;
let server: RunSeqLive[];
let onSelect: (() => Promise<void>) | null = null;

function casTable() {
  supa.setTable("run_sequence", async (call) => {
    if (call.verb !== "update") {
      const answer = server.map((r) => ({ ...r }));
      const hook = onSelect;
      onSelect = null;
      if (hook) await hook(); // something lands while this answer is on its way back
      return ok(answer);
    }
    const r = server.find((x) => x.id === call.eq.id)!;
    const holds = call.filters.every((f) =>
      f.op === "eq" ? (r as Record<string, unknown>)[f.column] === f.value : true
    );
    if (!holds) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  });
}

const base = {
  festival: `${FEST} · ${DATE}`,
  queuedAt: 1,
  presses: ["p1"],
  topic: runOrderTopic(TENANT, DATE, FEST),
};
async function queueThisDevicesPress() {
  await enqueueRunSeq({ ...base, rowId: "A", label: "วงเปิด", patch: { status: "done", actual_end: T1 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, rowId: "B", label: "Seishin Kakumei", patch: { status: "live", actual_start: T1, offset_min: 0 }, expect: { status: "pending" } });
}

function mount(initial: RunSeqLive[]) {
  render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={initial} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

const nowTitle = () =>
  within(document.querySelector<HTMLElement>(".now")!).getByRole("heading", { level: 2 }).textContent;

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: T0, offset_min: 0 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei" }),
    row({ id: "C", sort_order: 3, title: "เกมชิงรางวัล" }),
  ];
  onSelect = null;
  casTable();
});

describe("EventLiveCaller — the queue and the rows, read in the right order", () => {
  it("a press that lands while the board is re-reading never drops off the board", async () => {
    await queueThisDevicesPress();
    mount(server.map((r) => ({ ...r })));
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    await waitFor(() => expect(nowTitle()).toBe("Seishin Kakumei")); // the overlay
    // the board re-reads; its press lands (another tab's flush) while the rows are in flight
    onSelect = async () => {
      server[0] = { ...server[0], status: "done", actual_end: T1 };
      server[1] = { ...server[1], status: "live", actual_start: T1, offset_min: 0 };
      await drainedByAnotherTab();
    };
    await act(async () => {
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "other-device" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(nowTitle()).toBe("Seishin Kakumei");
  });

  it("a press that PARKS gives the board back to the server's rows", async () => {
    await queueThisDevicesPress();
    mount(server.map((r) => ({ ...r })));
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    // meanwhile another device ran the show on: A and B done, C live
    server[0] = { ...server[0], status: "done", actual_end: T1 };
    server[1] = { ...server[1], status: "done", actual_start: T1, actual_end: T2, offset_min: 0 };
    server[2] = { ...server[2], status: "live", actual_start: T2, offset_min: 0 };
    await act(async () => {
      await flushRunSeqOutbox(); // this device's press parks (A is no longer live)
    });
    await waitFor(() => expect(nowTitle()).toBe("เกมชิงรางวัล"));
  });
});
