// The caller's queue banners name THIS board's presses only (2026-10-26).
//
// The run-order queue is one IndexedDB store for every festival this device ever
// called, and a press that parked at last week's show stays until someone taps ทิ้ง.
// The caller listed all of it - so every later board on that device opened with the
// red "คิวถูกเปลี่ยนจากเครื่องอื่นระหว่างที่เครื่องนี้ออฟไลน์" alarm naming an act
// (bands repeat across shows) and telling the operator to check "the board below",
// which held no such press.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import type { RunSeqOp } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";

const h = vi.hoisted(() => ({ supa: null as unknown, ops: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/run-order-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/run-order-outbox")>()),
  listRunSeqOps: async () => h.ops,
}));

const TENANT = "t1";
const board: RunSeqLive[] = [
  { id: "today-1", sort_order: 1, title: "Seishin Kakumei", kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null, actual_start: null, actual_end: null, status: "pending", offset_min: null },
  { id: "today-2", sort_order: 2, title: "ปิดงาน", kind: "other", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null, actual_start: null, actual_end: null, status: "pending", offset_min: null },
];

const lastWeek = (over: Partial<RunSeqOp> = {}): RunSeqOp => ({
  rowId: "last-week-7",
  festival: "WARUDO SHOW · 2026-10-19",
  topic: runOrderTopic(TENANT, "2026-10-19", "WARUDO SHOW"),
  patch: { status: "live", actual_start: "2026-10-19T12:00:00.000Z" },
  expect: { status: "pending" },
  label: "Seishin Kakumei",
  queuedAt: 1,
  ...over,
});

const today = (over: Partial<RunSeqOp> = {}): RunSeqOp => ({
  rowId: "today-1",
  festival: "SPORT DAY · 2026-10-26",
  topic: runOrderTopic(TENANT, "2026-10-26", "SPORT DAY"),
  patch: { status: "live" },
  expect: { status: "pending" },
  label: "เริ่ม: Seishin Kakumei",
  queuedAt: 2,
  ...over,
});

function renderBoard() {
  render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName="SPORT DAY" eventDate="2026-10-26" eventId="ev-1" initial={board} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

/** let the queue read land */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", ok(board));
  h.supa = supa;
  h.ops = [];
});

describe("EventLiveCaller — queue banners for this board only", () => {
  it("does not raise another festival's parked press", async () => {
    h.ops = [lastWeek({ conflict: true })];
    renderBoard();
    await settle();
    expect(screen.queryByText(/คิวถูกเปลี่ยนจากเครื่องอื่น/)).toBeNull();
  });

  it("does not count another festival's unsent presses as this board's", async () => {
    h.ops = [lastWeek(), today()];
    renderBoard();
    await screen.findByText(/ค้างซิงค์ 1 รายการ/);
    expect(screen.queryByText(/ค้างซิงค์ 2 รายการ/)).toBeNull();
  });

  it("raises this board's own parked presses - by topic, or by row for an older record - and only those", async () => {
    h.ops = [
      lastWeek({ conflict: true }),
      today({ conflict: true }),
      // a row of this board, queued by a build before presses carried a topic
      today({ rowId: "today-2", topic: undefined, label: "เริ่ม: ปิดงาน", conflict: true }),
    ];
    renderBoard();
    await screen.findByText(/คิวถูกเปลี่ยนจากเครื่องอื่น.*\(2\)/);
    expect(screen.getByText("เริ่ม: Seishin Kakumei")).toBeInTheDocument();
    expect(screen.getByText("เริ่ม: ปิดงาน")).toBeInTheDocument();
    expect(screen.queryByText("Seishin Kakumei", { selector: "li span" })).toBeNull();
  });
});
