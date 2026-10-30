// A festival day that runs past midnight. 2026-10-30, hunt 11: the Overview ordered a day by
// the plain clock, so a countdown (22:00, 23:00, then the 00:00 headliner - every act on the
// festival's date, the way run_sequence keys it) printed its 00:00 act FIRST, on the board
// and in the crew JPG, and its 00:30 booth at the top of the booth table. The day is now read
// round its latest act (lib/day-order.ts dayOrderSeconds, the event sheet's rule): the small
// hours after an evening day go to its end. A day with no slot in the small hours keeps
// exactly the order it had.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";

vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "44444444-4444-4444-8444-444444444444";

function ev(over: Partial<OverviewEvent> & { id: string }): OverviewEvent {
  return {
    name: "COUNTDOWN 2027",
    group_id: A,
    group_name: "Band A",
    group_color: "#A62A1C",
    exempt_from_deadline: false,
    event_date: "2026-12-31",
    status: "approved",
    deadline: null,
    stage: { start: "22:00:00", end: "22:20:00" },
    booth: null,
    photo: null,
    photoEnd: null,
    tenant_id: "33333333-3333-4333-8333-333333333333",
    canEditPhoto: false,
    photoItemId: null,
    photoSortOrder: 0,
    copyrightPending: 0,
    copyrightRejected: 0,
    incomplete: 0,
    missingLabels: [],
    notes: null,
    ...over,
  };
}

const BANDS: OverviewBand[] = [
  { id: A, name: "Band A", color: "#A62A1C", contact_name: null, contact_phone: null, members: [] },
  { id: B, name: "Band B", color: null, contact_name: null, contact_phone: null, members: [] },
  { id: C, name: "Band C", color: null, contact_name: null, contact_phone: null, members: [] },
];

/** Listed in the WRONG order on purpose: the board must sort them. */
const COUNTDOWN = [
  ev({ id: "c", group_id: C, group_name: "Band C", stage: { start: "00:00:00", end: "00:20:00" }, booth: { start: "00:30:00", end: "01:00:00" }, photo: "01:10:00" }),
  ev({ id: "a", group_id: A, group_name: "Band A", stage: { start: "22:00:00", end: "22:20:00" }, booth: { start: "22:40:00", end: "23:20:00" }, photo: "21:30:00" }),
  ev({ id: "b", group_id: B, group_name: "Band B", stage: { start: "23:00:00", end: "23:20:00" }, booth: { start: "23:40:00", end: "00:10:00" }, photo: "22:30:00" }),
];

function mount(events: OverviewEvent[], todayKey = "2026-12-30") {
  return render(
    <OverviewClient
      events={events}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents
      isLabelWide
      canOpenDetail
      todayKey={todayKey}
    />
  );
}

/** The off-screen block the JPG is captured from (client-only, aria-hidden). */
const exportBlock = (c: HTMLElement) => c.querySelector<HTMLElement>("div.fixed[aria-hidden]")!;

/** The order the bands appear in under one table heading of `root`'s text. */
function bandOrderAfter(text: string, heading: string, next: string | null): string[] {
  const from = text.indexOf(heading);
  const to = next ? text.indexOf(next, from + heading.length) : text.length;
  const part = text.slice(from, to < 0 ? text.length : to);
  return ["Band A", "Band B", "Band C"]
    .map((b) => ({ b, at: part.indexOf(b) }))
    .filter((x) => x.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((x) => x.b);
}

/** The board's stage stubs (on screen, not the JPG block), by band, top to bottom. */
function boardStageOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("li"))
    .filter((li) => !exportBlock(container).contains(li) && (li.textContent ?? "").includes("ขึ้นเวที"))
    .map((li) => ["Band A", "Band B", "Band C"].find((b) => (li.textContent ?? "").includes(b)))
    .filter((b): b is string => !!b);
}

afterEach(() => cleanup());

describe("a festival day that crosses midnight", () => {
  it.each(["รายงาน", "รายวัน"])("%s view: the JPG lists stage, booth and photo in the order they happen", (view) => {
    const { container } = mount(COUNTDOWN);
    fireEvent.click(screen.getByRole("button", { name: view }));
    const text = exportBlock(container).textContent ?? "";
    expect(bandOrderAfter(text, "ขึ้นแสดง (Stage)", "บูธ (Booth)")).toEqual(["Band A", "Band B", "Band C"]);
    expect(bandOrderAfter(text, "บูธ (Booth)", "สร้างจาก CueIQ")).toEqual(["Band A", "Band B", "Band C"]);
  });

  it.each(["รายงาน", "รายวัน"])("%s view: the board's stage list reads 22:00, 23:00, 00:00", (view) => {
    const { container } = mount(COUNTDOWN);
    fireEvent.click(screen.getByRole("button", { name: view }));
    const order = boardStageOrder(container);
    expect(order.slice(0, 3)).toEqual(["Band A", "Band B", "Band C"]);
  });

  it("the photo table (and its JPG part) reads 21:30, 22:30, 01:10", () => {
    const { container } = mount(COUNTDOWN);
    fireEvent.click(screen.getByRole("button", { name: "รายงาน" }));
    const text = exportBlock(container).textContent ?? "";
    expect(text).toContain("ถ่ายรูป");
    const photoHeading = text.match(/ถ่ายรูป[^·]*·\s*3/)?.[0] ?? "ถ่ายรูป";
    expect(bandOrderAfter(text, photoHeading, "บูธ (Booth)")).toEqual(["Band A", "Band B", "Band C"]);
  });

  it("the Today hero lists today's countdown acts in the order they go on", () => {
    mount(COUNTDOWN, "2026-12-31");
    const hero = screen.getByRole("region", { name: "วันนี้" });
    const names = within(hero)
      .getAllByRole("listitem")
      .map((li) => ["Band A", "Band B", "Band C"].find((b) => (li.textContent ?? "").includes(b)));
    expect(names).toEqual(["Band A", "Band B", "Band C"]);
  });
});

describe("a day with no slot after midnight keeps its plain clock order", () => {
  const DAYTIME = [
    ev({ id: "late", name: "Daytime Fest", group_id: C, group_name: "Band C", stage: { start: "23:30:00", end: "23:50:00" }, booth: { start: "07:00:00", end: "07:30:00" } }),
    ev({ id: "mid", name: "Daytime Fest", group_id: B, group_name: "Band B", stage: { start: "13:00:00", end: "13:20:00" }, booth: { start: "23:55:00", end: "00:30:00" } }),
    ev({ id: "early", name: "Daytime Fest", group_id: A, group_name: "Band A", stage: { start: "06:00:00", end: "06:20:00" }, booth: { start: "14:00:00", end: "14:30:00" } }),
  ];

  it.each(["รายงาน", "รายวัน"])("%s view: stage 06:00, 13:00, 23:30; booth 07:00, 14:00, 23:55", (view) => {
    const { container } = mount(DAYTIME);
    fireEvent.click(screen.getByRole("button", { name: view }));
    const text = exportBlock(container).textContent ?? "";
    expect(bandOrderAfter(text, "ขึ้นแสดง (Stage)", "บูธ (Booth)")).toEqual(["Band A", "Band B", "Band C"]);
    expect(bandOrderAfter(text, "บูธ (Booth)", "สร้างจาก CueIQ")).toEqual(["Band C", "Band A", "Band B"]);
    expect(boardStageOrder(container).slice(0, 3)).toEqual(["Band A", "Band B", "Band C"]);
  });

  it("the Today hero keeps the plain clock order", () => {
    mount(DAYTIME, "2026-12-31");
    const hero = screen.getByRole("region", { name: "วันนี้" });
    const names = within(hero)
      .getAllByRole("listitem")
      .map((li) => ["Band A", "Band B", "Band C"].find((b) => (li.textContent ?? "").includes(b)));
    expect(names).toEqual(["Band A", "Band B", "Band C"]);
  });
});
