import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";
import { EventRunStatusCard } from "./event-run-status";

// ─────────────────────────────────────────────────────────────────────────────
// A PLANNED GAP BETWEEN TWO ACTS (2026-10-27, hunt 8).
//
// Replayed from a REAL run order (the 2026-06-27 festival in run_sequence: clocks as
// stored, titles anonymised). Its plan has gaps - 12:50 → 14:00, 15:20 → 15:30,
// 15:50 → 16:40 - and so does every other one the label has built. "จบ + ต่อไป" was the
// only key that ended an act, so at 12:50 it put the 14:00 act on stage with drift −70
// ("เร็ว 70 น." on every device; that band's own page said "กำลังเล่น" 70 min early) -
// or, if the caller waited, the act that had left the stage stayed live and "เกิน" for
// 70 min. The board now offers "จบ" alone before a gap; "เริ่มลำดับถัดไป" starts the next
// act at its real time. And between acts nothing says "จบงานแล้ว" while an act still waits.
// ─────────────────────────────────────────────────────────────────────────────

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

const TENANT = "t1";
const FEST = "Festival 0627";
const DATE = "2026-06-27";
const PLAN: [string, string][] = [
  ["12:30:00", "12:50:00"],
  ["14:00:00", "14:20:00"],
  ["14:20:00", "14:40:00"],
  ["14:40:00", "15:00:00"],
  ["15:00:00", "15:20:00"],
  ["15:30:00", "15:50:00"],
  ["16:40:00", "17:40:00"],
];
function realRows(): RunSeqLive[] {
  return PLAN.map(([s, e], i) => ({
    id: `r${i + 1}`,
    sort_order: i + 1,
    title: `act ${i + 1}`,
    kind: "band",
    planned_start: s,
    planned_end: e,
    buffer_seconds: 0,
    linked_event_id: `ev-${i + 1}`,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
  }));
}
const at = (clock: string) => new Date(`${DATE}T${clock}+07:00`);
const iso = (clock: string) => at(clock).toISOString();

let supa: SupabaseFake;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => vi.useRealTimers());

function serve(rows: RunSeqLive[]) {
  supa.setTable("run_sequence", (call) =>
    call.verb === "update" ? ok([{ id: call.eq.id }]) : ok(rows)
  );
}
function renderCaller(rows: RunSeqLive[]) {
  return render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller
          tenantId={TENANT}
          eventName={FEST}
          eventDate={DATE}
          eventId="ev-1"
          initial={rows}
          canControl
        />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}
function renderCard(rows: RunSeqLive[], self: string) {
  return render(
    <EventRunStatusCard
      rows={rows}
      selfEventId={self}
      tenantId={TENANT}
      eventName={FEST}
      eventDate={DATE}
    />
  );
}
const endOnlyKey = () => screen.queryByRole("button", { name: /\(ยังไม่เริ่มลำดับถัดไป\)/ });
const played = (r: RunSeqLive, from: string, to: string): RunSeqLive => ({
  ...r,
  status: "done",
  actual_start: iso(from),
  actual_end: iso(to),
  offset_min: 0,
});

describe("EventLiveCaller — the end-only key before a planned gap", () => {
  it("act 1 ends at 12:50: 'จบ' writes only its end, as a compare-and-swap, and act 2 (14:00) stays pending", async () => {
    const rows = realRows();
    rows[0] = { ...rows[0], status: "live", actual_start: iso("12:30:00"), offset_min: 0 };
    serve(rows);
    vi.setSystemTime(at("12:50:00"));
    renderCaller(rows);
    // the primary key is unchanged
    expect(screen.getByRole("button", { name: /จบ \+ ต่อไป · act 2/ })).toBeTruthy();
    const key = endOnlyKey();
    expect(key, "no way to end act 1 without putting act 2 on stage 70 min early").not.toBeNull();
    fireEvent.click(key!);
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [end] = supa.callsTo("run_sequence", "update");
    expect(end.eq).toMatchObject({ id: "r1", status: "live" });
    expect(end.values).toMatchObject({ status: "done", actual_end: iso("12:50:00") });
    expect(end.values).not.toHaveProperty("offset_min");
  });

  it("is not offered when the next act follows straight on (14:00-14:20 → 14:20)", () => {
    const rows = realRows();
    rows[0] = played(rows[0], "12:30:00", "12:50:00");
    rows[1] = { ...rows[1], status: "live", actual_start: iso("14:00:00"), offset_min: 0 };
    serve(rows);
    vi.setSystemTime(at("14:20:00"));
    renderCaller(rows);
    expect(endOnlyKey()).toBeNull();
  });

  it("between acts the board names the next act and its time, and START begins it from the real clock", async () => {
    const rows = realRows();
    rows[0] = played(rows[0], "12:30:00", "12:50:00");
    serve(rows);
    vi.setSystemTime(at("13:58:00"));
    const { container } = renderCaller(rows);
    const between = container.querySelector("[data-cueiq-between]");
    expect(between?.textContent, "the NOW card said 'จบงานแล้ว' with six acts to go").toContain(
      "ถัดไป: act 2"
    );
    expect(between?.textContent).toContain("14:00");
    fireEvent.click(screen.getByRole("button", { name: /เริ่มลำดับถัดไป · act 2/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [s] = supa.callsTo("run_sequence", "update");
    expect(s.eq).toMatchObject({ id: "r2", status: "pending" });
    expect(s.values).toMatchObject({ status: "live", offset_min: -2 });
  });
});

describe("EventRunStatusCard — between acts is not the end of the show", () => {
  it("an act still waits: the festival line names it instead of 'จบงานแล้ว'", () => {
    const rows = realRows().slice(0, 3);
    rows[0] = played(rows[0], "12:30:00", "12:50:00");
    serve(rows);
    vi.setSystemTime(at("13:00:00"));
    const { container } = renderCard(rows, "ev-3");
    expect(container.textContent, "bands still to play were told the show is over").not.toContain(
      "จบงานแล้ว"
    );
    expect(container.querySelector("[data-cueiq-between]")?.textContent).toMatch(
      /ถัดไป: act 2 · คาดเริ่ม 14:00/
    );
  });

  it("an act left pending ABOVE the ones that played (reordered mid-show) still counts as to come", () => {
    const rows = realRows().slice(0, 3);
    rows[1] = played(rows[1], "14:00:00", "14:20:00");
    rows[2] = played(rows[2], "14:20:00", "14:40:00");
    serve(rows);
    vi.setSystemTime(at("14:41:00"));
    const { container } = renderCard(rows, "ev-1");
    expect(container.textContent).not.toContain("จบงานแล้ว");
  });

  it("every act played: 'จบงานแล้ว' as before", () => {
    const rows = realRows()
      .slice(0, 2)
      .map((r, i) => played(r, PLAN[i][0], PLAN[i][1]));
    serve(rows);
    vi.setSystemTime(at("14:30:00"));
    const { container } = renderCard(rows, "ev-1");
    expect(container.textContent).toContain("จบงานแล้ว");
  });
});
