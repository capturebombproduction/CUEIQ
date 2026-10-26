// Two running-order rows on ONE sort_order (2026-10-26 bug hunt).
//
// Two staff screens adding a row at once can give both new rows the same number, and
// Postgres hands tied rows back in no promised order. The show-caller sorted on
// sort_order alone and picked "next" as the first pending row with a HIGHER number
// than the live one - so the act tied with the live act was skipped: the key read
// "จบ + ต่อไป · Seishin" while "Game" was still waiting, and Game was never called.
// Every screen now sorts with lib/run-order-sort.ts and walks rows by POSITION.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";
import { EventRunStatusCard } from "./event-run-status";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/run-order-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/run-order-outbox")>()),
  listRunSeqOps: async () => [],
  enqueueRunSeq: async () => {},
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const FEST = "A Lot Of Tone Fest";
const DATE = "2026-08-09";
let supa: SupabaseFake;

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

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => vi.clearAllMocks());

function renderCaller(rows: RunSeqLive[]) {
  supa.setTable("run_sequence", (call) => (call.verb === "update" ? ok([{ id: call.eq.id }]) : ok(rows)));
  return render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId="t1" eventName={FEST} eventDate={DATE} eventId="ev-1" initial={rows} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

describe("EventLiveCaller — two rows on one sort_order", () => {
  it("the NEXT key names the pending act tied with the live one", () => {
    renderCaller([
      row({ id: "r1", sort_order: 1, title: "Opening", status: "done", actual_start: ago(3e6), actual_end: ago(6e5) }),
      row({ id: "r2", sort_order: 2, title: "Break", status: "live", actual_start: ago(6e5) }),
      row({ id: "r3", sort_order: 2, title: "Game" }),
      row({ id: "r4", sort_order: 3, title: "Seishin" }),
    ]);
    expect(screen.queryByText("จบ + ต่อไป · Seishin")).toBeNull();
    expect(screen.getByText("จบ + ต่อไป · Game")).toBeInTheDocument();
  });

  it("the order does not depend on the order the server sent the tied rows in", () => {
    // the same board, the tied pair arriving the other way round
    renderCaller([
      row({ id: "r4", sort_order: 3, title: "Seishin" }),
      row({ id: "r3", sort_order: 2, title: "Game" }),
      row({ id: "r2", sort_order: 2, title: "Break", status: "live", actual_start: ago(6e5) }),
      row({ id: "r1", sort_order: 1, title: "Opening", status: "done", actual_start: ago(3e6), actual_end: ago(6e5) }),
    ]);
    expect(screen.getByText("จบ + ต่อไป · Game")).toBeInTheDocument();
  });
});

describe("EventRunStatusCard — ties read the way the board reads them", () => {
  // Two finished acts on one number: which one finished LAST decides the festival's
  // drift. Sorted on sort_order alone, that was whichever the server happened to send
  // last - so the band's card could say a different drift than the caller's board.
  const tied = [
    row({ id: "a", sort_order: 2, title: "Game", status: "done", actual_start: ago(9e5), actual_end: ago(6e5), offset_min: 1 }),
    row({ id: "b", sort_order: 2, title: "Break", status: "done", actual_start: ago(6e5), actual_end: ago(3e5), offset_min: 5 }),
    row({ id: "c", sort_order: 3, title: "Seishin", linked_event_id: "ev-1" }),
  ];

  function driftChip(rows: RunSeqLive[]): string {
    supa.setTable("run_sequence", ok(rows));
    const { container, unmount } = render(
      <EventRunStatusCard rows={rows} selfEventId="ev-1" tenantId="t1" eventName={FEST} eventDate={DATE} />
    );
    const text = container.querySelector(".chip")?.textContent ?? "";
    unmount();
    return text;
  }

  it("names the same drift whichever order the tied rows arrive in", () => {
    const forward = driftChip(tied);
    const backward = driftChip([...tied].reverse());
    expect(forward).toBe(backward);
    // compareRunOrder: the tie breaks on id, so "b" (offset +5) is the last done act
    expect(forward).toContain("ช้า +5");
  });
});
