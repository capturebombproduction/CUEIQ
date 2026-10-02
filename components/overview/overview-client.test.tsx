// THE APPROVAL QUEUE AS A PLACE YOU CAN LOOK.
//
// "Gorya seitan sai" sat at pending_review from 15 July, for a 19 July show, and
// was still there on 31 August. It was on THIS BOARD the whole time — visible,
// one tap from approval — inside a fifty-row list with nothing that said how many
// were waiting. The daily cron reminds approvers about shows still ahead; it can
// never help one whose date has passed. This chip is the other half.
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";

// The export button reaches for html-to-image; nothing here clicks it, and loading
// the real one costs a large dependency in every run of this file.
vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SEISHIN = "11111111-1111-4111-8111-111111111111";
const KOMA = "22222222-2222-4222-8222-222222222222";

function ev(over: Partial<OverviewEvent> & { id: string }): OverviewEvent {
  return {
    name: "งาน",
    group_id: SEISHIN,
    group_name: "Seishin Kakumei",
    group_color: null,
    exempt_from_deadline: false,
    event_date: "2026-08-20",
    status: "approved",
    deadline: null,
    stage: { start: "19:00", end: "19:30" },
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
  {
    id: SEISHIN,
    name: "Seishin Kakumei",
    color: null,
    contact_name: null,
    contact_phone: null,
    members: [],
  },
  { id: KOMA, name: "KŌMA", color: null, contact_name: null, contact_phone: null, members: [] },
];

// The real shape of the problem: one waiting submission whose show has already
// happened, plus an ordinary approved show, plus a waiting one on another band.
const GORYA = ev({
  id: "gorya",
  name: "Gorya seitan sai",
  event_date: "2026-07-19",
  status: "pending_review",
});
const DONE = ev({ id: "done", name: "Vasa seitan", event_date: "2026-08-23" });
const OTHER_BAND = ev({
  id: "koma",
  name: "KŌMA one man",
  group_id: KOMA,
  group_name: "KŌMA",
  status: "pending_review",
});

function mount(events: OverviewEvent[], canApproveEvents = true) {
  return render(
    <OverviewClient
      events={events}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents={canApproveEvents}
      isLabelWide
      canOpenDetail
    />
  );
}

/** The on-screen board only — the component also renders an off-screen copy of
 *  every row for the JPG export, so a bare getAllByText would double-count. */
function boardNames(): string[] {
  const chip = screen.getByTestId("approval-queue-chip");
  // The visible board is the chip's own scrollable region: walk up to the card
  // that holds both the toolbar and the tables.
  const board = chip.closest("div.space-y-4") ?? document.body;
  return Array.from(board.querySelectorAll("a, td"))
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("the approval queue chip", () => {
  it("counts every waiting submission, across all bands", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    expect(screen.getByTestId("approval-queue-chip")).toHaveTextContent("รออนุมัติ 2");
  });

  it("is not shown to someone who cannot approve", () => {
    mount([GORYA, DONE], false);
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
  });

  it("is not shown when nothing is waiting — a chip reading 0 is furniture", () => {
    mount([DONE], true);
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
  });

  // THE WHOLE POINT. A past-dated submission is exactly the one the cron cannot
  // reach, so if the chip skipped it the queue would still be invisible.
  it("filters the board down to the waiting ones, INCLUDING a show that has passed", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const chip = screen.getByTestId("approval-queue-chip");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(chip);
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "true");

    const shown = boardNames().join(" | ");
    expect(shown).toContain("Gorya seitan sai");
    expect(shown).toContain("KŌMA one man");
    expect(shown).not.toContain("Vasa seitan");
  });

  it("restores the full board when switched off again", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const chip = screen.getByTestId("approval-queue-chip");
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "false");
    expect(boardNames().join(" | ")).toContain("Vasa seitan");
  });

  // Written first as "the queue ignores the band filter", which is what `filtered`
  // does — and it FAILED, because in รายวง mode the board's sections are built from
  // bandFilter too, so one band's filter still hid a row the chip was counting.
  // The cure is that switching the queue on clears the filters, which also makes
  // the selects say what is actually on screen.
  it("clears the band filter, so the list always matches the number on the chip", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const bandSelect = screen.getAllByRole("combobox").at(-1)! as HTMLSelectElement;
    fireEvent.change(bandSelect, { target: { value: KOMA } });
    expect(bandSelect.value).toBe(KOMA);
    // The count speaks for the whole label even while a band filter is on.
    expect(screen.getByTestId("approval-queue-chip")).toHaveTextContent("รออนุมัติ 2");

    fireEvent.click(screen.getByTestId("approval-queue-chip"));

    expect((screen.getAllByRole("combobox").at(-1) as HTMLSelectElement).value).toBe("all");
    const shown = boardNames().join(" | ");
    expect(shown).toContain("Gorya seitan sai");
    expect(shown).toContain("KŌMA one man");
    expect(shown).not.toContain("Vasa seitan");
  });

  // queueActive is derived (`queueOnly && pendingCount > 0`) rather than stored,
  // precisely so that approving the last one cannot leave the viewer staring at an
  // empty board with the chip already gone and no way to switch it back off.
  it("cannot strand the viewer on an empty board when the last one is approved", () => {
    const { rerender } = mount([GORYA, DONE]);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(boardNames().join(" | ")).not.toContain("Vasa seitan");

    // …the approval lands and the row is no longer pending.
    rerender(
      <OverviewClient
        events={[{ ...GORYA, status: "approved" }, DONE]}
        bands={BANDS}
        staffContacts={[]}
        labelName="A Lot Of Tone"
        canApproveEvents
        isLabelWide
        canOpenDetail
      />
    );
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
    // The board is whole again, not empty.
    const body = within(document.body);
    expect(body.getAllByText(/Vasa seitan/).length).toBeGreaterThan(0);
  });
});

// CQ-12 — THE TODAY HERO MUST NOT CUT THE SHOW'S NAME.
//
// Seishin's real 10-03 show, "Welcome to friendverse", is pending_review — the widest
// status badge. The badge is shrink-0 (86-120px of a 326px row at 390), so it leaves
// the name roughly 106px at 390 and 76px at 360, and a single-line `truncate` cut the
// name and the venue to a few letters on the one screen the band opens before a show.
// The name and the venue line now wrap onto a second line instead.
//
// The geometry itself cannot be measured in jsdom (no layout engine) — the real-browser
// check is the harness at 360/390/430. What jsdom CAN guard is the class contract, and
// there is one trap worth pinning: Tailwind emits `.block` AFTER `.line-clamp-2`, so a
// stray `block` silently replaces the clamp's display:-webkit-box with display:block and
// the clamp stops clamping — with no error anywhere.
describe("the Today hero on a phone (CQ-12)", () => {
  const FRIENDVERSE = ev({
    id: "friendverse",
    name: "Welcome to friendverse",
    event_date: "2026-10-03",
    status: "pending_review",
    venue: "Bangkok Art and Culture Centre, Pathum Wan",
  });

  function hero(canOpenDetail: boolean) {
    const { container } = render(
      <OverviewClient
        events={[FRIENDVERSE]}
        bands={BANDS}
        staffContacts={[]}
        labelName="A Lot Of Tone"
        canApproveEvents
        isLabelWide
        canOpenDetail={canOpenDetail}
        todayKey="2026-10-03"
      />
    );
    const section = container.querySelector('section[aria-label="วันนี้"]');
    expect(section).not.toBeNull();
    return within(section as HTMLElement);
  }

  function expectWraps(el: HTMLElement) {
    expect(el.className).toContain("line-clamp-2");
    // Not one cut line…
    expect(el.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    // …and no `block` to override the clamp's display (see the note above).
    expect(el.className).not.toMatch(/(^|\s)block(\s|$)/);
  }

  it("lets the show name wrap to a second line instead of cutting it (tappable row)", () => {
    const name = hero(true).getByText("Welcome to friendverse");
    expect(name.tagName).toBe("A");
    expectWraps(name);
    expect(name.className).toContain("break-words");
  });

  it("does the same when the row is not a link", () => {
    const name = hero(false).getByText("Welcome to friendverse");
    expect(name.tagName).toBe("SPAN");
    expectWraps(name);
    expect(name.className).toContain("break-words");
  });

  it("lets the band · venue line wrap too", () => {
    const line = hero(true).getByText(
      "Seishin Kakumei · Bangkok Art and Culture Centre, Pathum Wan"
    );
    expectWraps(line);
  });
});

// ===========================================================================
// ROUND 15, WAVE 2 — the Overview's focus views, JPG, print and touch targets.
// ===========================================================================
const TODAY = "2026-10-02";

function mountAt(
  events: OverviewEvent[],
  props: Partial<ComponentProps<typeof OverviewClient>> = {}
) {
  return render(
    <OverviewClient
      events={events}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents
      isLabelWide
      canOpenDetail
      todayKey={TODAY}
      {...props}
    />
  );
}

/** The off-screen block the JPG is captured from (client-only, aria-hidden). */
const exportBlock = (c: HTMLElement) => c.querySelector<HTMLElement>("div.fixed[aria-hidden]")!;

/** One activity table of the JPG ("(Stage)" / "(Photo)" / "(Booth)"). */
function exportTable(c: HTMLElement, which: "Stage" | "Photo" | "Booth"): HTMLElement {
  const h4 = Array.from(exportBlock(c).querySelectorAll("h4")).find((h) =>
    h.textContent?.includes(`(${which})`)
  );
  expect(h4, `the JPG has no ${which} table`).toBeTruthy();
  return h4!.parentElement as HTMLElement;
}

/** The board's own rows — not the JPG copy, not the closed Past fold. */
const boardRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("li.stub")).filter((li) => !li.closest("details"));

/** The number beside the board's heading ("Upcoming  4 งาน"). */
function headingCount(): number {
  const h = screen.getAllByRole("heading", { level: 2 })[0];
  return Number(/(\d+)\s*งาน/.exec(h.parentElement!.textContent ?? "")![1]);
}

// CQ-31 — A FOCUS AND THE BAND PICKER MUST NOT DISAGREE.
//
// A focus ignores the band and date filters (it shows exactly what its count promises),
// and switching one ON clears them. But the two selects set their filter WITHOUT leaving
// the focus, so under the queue focus a band pick left the focus on and the board built
// from one band — the heading and the chip still counting every band, over rows of one.
describe("a focus and the band / day pickers agree (CQ-31)", () => {
  const Q_SEISHIN = ev({ id: "q1", name: "Queue one", event_date: "2026-10-10", status: "pending_review" });
  const Q_KOMA = ev({
    id: "q2",
    name: "Queue two",
    group_id: KOMA,
    group_name: "KŌMA",
    event_date: "2026-10-10",
    status: "pending_review",
  });
  const OK_SEISHIN = ev({ id: "a1", name: "Approved one", event_date: "2026-10-11" });
  const OK_KOMA = ev({
    id: "a2",
    name: "Approved two",
    group_id: KOMA,
    group_name: "KŌMA",
    event_date: "2026-10-12",
  });
  const ALL = [Q_SEISHIN, Q_KOMA, OK_SEISHIN, OK_KOMA];

  it("picking a band under the queue focus leaves the focus, and the heading counts the rows shown", () => {
    const { container } = mountAt(ALL);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "true");
    expect(headingCount()).toBe(2);
    expect(boardRows(container)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("เลือกวง"), { target: { value: KOMA } });

    // The focus is off — a focus and a band filter never both apply…
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "false");
    // …the board is that band's two upcoming shows, and the number over it is theirs.
    const rows = boardRows(container);
    expect(rows.map((r) => r.textContent).join(" | ")).toMatch(/Queue two.*Approved two/);
    expect(rows.map((r) => r.textContent).join(" | ")).not.toContain("Queue one");
    expect(headingCount()).toBe(rows.length);
  });

  it("picking a day under a focus leaves the focus too (it was a silent no-op)", () => {
    const { container } = mountAt(ALL);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByLabelText("เลือกวัน"), { target: { value: "2026-10-11" } });

    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "false");
    const rows = boardRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Approved one");
    expect(headingCount()).toBe(1);
  });
});

// CQ-32 / CQ-33 — THE JPG CARRIES THE ACT TAG, AND ONE LONG NAME CANNOT PUSH IT OFF THE EDGE.
//
// "G-D!" is how the crew knows which unit HatoBito's 11:50 slot is. The board shows it as
// a chip (ActNote); ExportActivityCol never read ev.notes, so the picture handed to the
// crew left it out. And the export's `[&_td]:whitespace-nowrap` plus a fixed 820 px
// capture meant one ~90-character show name pushed every time in its table past the edge.
describe("the JPG export (CQ-32, CQ-33)", () => {
  const GD = ev({
    id: "gd",
    name: "Idol Paradise",
    event_date: "2026-10-10",
    notes: "G-D!",
    photo: "10:00",
    photoEnd: "10:10",
    booth: { start: "11:00", end: "11:30" },
  });
  const WORDY = ev({
    id: "wordy",
    name: "Another Show",
    group_id: KOMA,
    group_name: "KŌMA",
    event_date: "2026-10-10",
    notes: "this is a description, not an act name",
    photo: "10:30",
    photoEnd: "10:40",
  });

  it("puts the act tag in the Stage table, as the board shows it", () => {
    const { container } = mountAt([GD, WORDY]);
    expect(exportTable(container, "Stage").textContent).toContain("G-D!");
  });

  it("leaves it out of Photo and Booth, which stay clean on screen too", () => {
    const { container } = mountAt([GD, WORDY]);
    expect(exportTable(container, "Photo").textContent).not.toContain("G-D!");
    expect(exportTable(container, "Booth").textContent).not.toContain("G-D!");
  });

  it("applies the board's own rule: a note too long to be a label is not printed", () => {
    const { container } = mountAt([GD, WORDY]);
    expect(exportBlock(container).textContent).not.toContain("this is a description");
  });

  // Geometry is not measurable in jsdom: this pins the class contract, and the real
  // check (export node scrollWidth <= 820 with a ~90-char show name) is the harness.
  it("wraps the name cell inside a capped width; only the time cell stays on one line", () => {
    const { container } = mountAt([GD, WORDY]);
    const table = exportTable(container, "Stage").querySelector("table")!;
    expect(table.className).not.toContain("whitespace-nowrap");
    const [nameTd, timeTd] = Array.from(table.querySelectorAll("tr")[0].querySelectorAll("td"));
    expect(timeTd.className).toContain("whitespace-nowrap");
    const wrap = nameTd.firstElementChild as HTMLElement;
    expect(wrap.className).toContain("w-max");
    expect(wrap.className).toContain("max-w-[34rem]");
    expect(wrap.className).toContain("whitespace-normal");
  });
});

// CQ-34 — A DEAD BUTTON SHOULD SAY WHAT WOULD WAKE IT.
describe("'บันทึกเป็นรูป' when nothing is upcoming (CQ-34)", () => {
  const PAST_SHOW = ev({ id: "p", name: "Vasa seitan", event_date: "2026-09-20" });
  const NEXT_SHOW = ev({ id: "n", name: "Next show", event_date: "2026-10-10" });
  const HINT = "เปิด PAST ด้านล่างเพื่อบันทึกเป็นรูป";
  const exportButton = () => screen.getByRole("button", { name: "บันทึกเป็นรูป" });

  it("explains itself while it is disabled because only the shut Past fold has shows", () => {
    mountAt([PAST_SHOW]);
    const btn = exportButton();
    expect(btn).toBeDisabled();
    const hint = screen.getByText(HINT);
    expect(btn.getAttribute("aria-describedby")).toBe(hint.id);
    expect(btn.getAttribute("title")).toContain("PAST");
  });

  it("drops the hint once Past is open, and the button works", () => {
    const { container } = mountAt([PAST_SHOW]);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.queryByText(HINT)).toBeNull();
    expect(exportButton()).toBeEnabled();
    expect(exportButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("has no hint when something is upcoming, or when there is nothing at all to open", () => {
    mountAt([PAST_SHOW, NEXT_SHOW]);
    expect(screen.queryByText(HINT)).toBeNull();
    cleanup();
    mountAt([]);
    expect(exportButton()).toBeDisabled();
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

// CQ-35 — FESTIVALS THAT SHARE A LONG PREFIX MUST STILL TELL APART.
describe("per-festival run-order controls (CQ-35)", () => {
  const DAY1 = "Japan Expo Thailand 2026 — Idol Stage Day 1";
  const DAY2 = "Japan Expo Thailand 2026 — Idol Stage Day 2";
  const D1 = ev({ id: "d1", name: DAY1, event_date: "2026-10-10" });
  const D2 = ev({ id: "d2", name: DAY2, event_date: "2026-10-11" });
  const RUN = [`${DAY1}__2026-10-10`, `${DAY2}__2026-10-11`];

  function weekView(events: OverviewEvent[]) {
    const view = mountAt(events, { runOrderFestivals: RUN });
    fireEvent.click(screen.getByRole("button", { name: "รายสัปดาห์" }));
    return view;
  }

  it("names the festival in each link, so the two sets of links are not the same two links", () => {
    weekView([D1, D2]);
    expect(screen.getByRole("link", { name: /Running Order — .*Day 1/ })).toHaveAttribute(
      "href",
      "/events/d1/run-order?from=overview"
    );
    expect(screen.getByRole("link", { name: /Running Order — .*Day 2/ })).toHaveAttribute(
      "href",
      "/events/d2/run-order?from=overview"
    );
    expect(screen.getByRole("link", { name: /คุมคิว \(Live\) — .*Day 2/ })).toHaveAttribute(
      "href",
      "/events/d2/run-order/live?from=overview"
    );
  });

  it("shows the festival's label on two lines with the full name as a tooltip, not cut at 160 px", () => {
    weekView([D1, D2]);
    const label = screen.getByTitle(DAY2);
    expect(label.className).toContain("line-clamp-2");
    expect(label.className).toContain("max-w-[14rem]");
    expect(label.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    // …and no `block`, which would override the clamp's display (see CQ-12 above).
    expect(label.className).not.toMatch(/(^|\s)block(\s|$)/);
  });

  it("keeps the plain names when there is only one festival to tell apart", () => {
    weekView([D1]);
    expect(screen.getByRole("link", { name: "Running Order" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /คุมคิว \(Live\)/ }).getAttribute("aria-label")).toBeNull();
  });
});

// CQ-29 — PRINTING THE OVERVIEW PRINTS ITS CONTROLS.
//
// theme.css's print block hides `.no-print`; nothing on this screen used it. (The class
// is the contract — what paper then looks like is the harness's page.pdf.)
describe("print hides the controls (CQ-29)", () => {
  it("marks the hero actions, the quick-filter tiles, the view switch and the pickers no-print", () => {
    mountAt([
      ev({ id: "a", event_date: "2026-10-10", status: "pending_review" }),
      ev({ id: "b", event_date: "2026-10-11", group_id: KOMA, group_name: "KŌMA" }),
    ]);
    const noPrint = (el: HTMLElement | null) => expect(el?.className).toMatch(/(^|\s)no-print(\s|$)/);
    noPrint(screen.getByRole("button", { name: "บันทึกเป็นรูป" }).parentElement);
    noPrint(screen.getByRole("group", { name: "ตัวกรองด่วน" }));
    noPrint(screen.getByRole("group", { name: "มุมมอง" }));
    noPrint(screen.getByLabelText("เลือกวง").parentElement);
  });

  it("leaves the schedule itself printable", () => {
    const { container } = mountAt([ev({ id: "a", name: "Printed show", event_date: "2026-10-10" })]);
    const row = boardRows(container)[0];
    expect(row.closest(".no-print")).toBeNull();
  });

  it("an editable photo time prints as its time, not as two input boxes", () => {
    mountAt([ev({ id: "a", event_date: "2026-10-10", canEditPhoto: true, photo: "10:00", photoEnd: "10:10" })]);
    const field = screen.getByLabelText("เวลาเริ่มถ่ายรูป");
    expect(field.closest(".print\\:hidden"), "the inputs leave the page").not.toBeNull();
    const printed = Array.from(document.querySelectorAll<HTMLElement>(".print\\:inline"));
    expect(printed.map((e) => e.textContent)).toContain("10:00–10:10");
    expect(printed[0]).toHaveClass("hidden"); // and never on screen or in the JPG
  });

  it("a SHUT Past fold is a control (its rows do not print): the bar stays off paper; open, it prints", () => {
    mountAt([ev({ id: "a", event_date: "2026-10-10" }), ev({ id: "old", name: "Old show", event_date: "2026-09-01" })]);
    const fold = screen.getByText("Past").closest("details")!;
    expect(fold.className).toMatch(/(^|\s)no-print(\s|$)/);
    fireEvent.click(screen.getByText("Past"));
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect(fold.className).not.toMatch(/(^|\s)no-print(\s|$)/);
  });

  it("the 'ยังไม่กำหนดเวลาถ่ายรูป' disclosure bar is a control: not on paper", () => {
    mountAt([ev({ id: "a", event_date: "2026-10-10", canEditPhoto: true })]);
    const bar = screen.getByRole("button", { name: /ยังไม่กำหนดเวลาถ่ายรูป/ }).closest("tr")!;
    expect(bar.className).toMatch(/(^|\s)no-print(\s|$)/);
  });
});

// CQ-36 — A TOUCH iPAD IS NOT A MOUSE.
//
// `sm:` (>= 640 px wide) was the proxy for "a pointer": a touch iPad, and a phone held
// landscape, both clear it and got 36 px fields and 38 px tabs. The shrink now follows the
// pointer. (Heights are measured in the harness at 768 with hasTouch; jsdom has no layout.)
describe("touch targets shrink for a precise pointer, not for a wide screen (CQ-36)", () => {
  const tokens = (el: Element) => el.className.split(/\s+/);

  it("the band / day pickers are 44 px until the pointer is fine", () => {
    mountAt([
      ev({ id: "a", event_date: "2026-10-10" }),
      ev({ id: "b", event_date: "2026-10-11", group_id: KOMA, group_name: "KŌMA" }),
    ]);
    for (const label of ["เลือกวง", "เลือกวัน"]) {
      const t = tokens(screen.getByLabelText(label));
      expect(t).toContain("h-11");
      expect(t.some((c) => c.startsWith("[@media(pointer:fine)]:h-"))).toBe(true);
      expect(t.some((c) => /^sm:h-/.test(c))).toBe(false);
    }
  });

  it("the view switch keeps its 44 px tabs on touch at every width", () => {
    mountAt([ev({ id: "a" })]);
    const seg = tokens(screen.getByRole("group", { name: "มุมมอง" }));
    expect(seg).toContain("[&>*]:h-11");
    expect(seg).toContain("[@media(pointer:fine)]:[&>*]:h-[38px]");
    expect(seg.some((c) => c.startsWith("sm:[&>*]:h-"))).toBe(false);
  });

  it("the inline photo-time fields are 44 px until the pointer is fine", () => {
    mountAt([ev({ id: "a", event_date: "2026-10-10", canEditPhoto: true, photo: "10:00", photoEnd: "10:10" })]);
    for (const label of ["เวลาเริ่มถ่ายรูป", "เวลาจบถ่ายรูป"]) {
      const t = tokens(screen.getByLabelText(label));
      expect(t).toContain("h-11");
      expect(t).toContain("[@media(pointer:fine)]:h-9");
      expect(t.some((c) => /^sm:h-/.test(c))).toBe(false);
    }
  });

  it("the run-order buttons are 44 px until the pointer is fine", () => {
    const NAME = "Idol Stage Day 1";
    mountAt([ev({ id: "d1", name: NAME, event_date: "2026-10-10" })], {
      runOrderFestivals: [`${NAME}__2026-10-10`],
    });
    fireEvent.click(screen.getByRole("button", { name: "รายสัปดาห์" }));
    for (const name of ["Running Order", /คุมคิว \(Live\)/]) {
      const t = tokens(screen.getByRole("link", { name }));
      expect(t).toContain("h-11");
      expect(t).toContain("[@media(pointer:fine)]:h-9");
      expect(t.some((c) => /^sm:h-/.test(c))).toBe(false);
    }
  });

  it("the to-do toggle under Photo is 44 px until the pointer is fine", () => {
    mountAt([ev({ id: "a", event_date: "2026-10-10", canEditPhoto: true })]);
    const toggle = screen.getByRole("button", { name: /ยังไม่กำหนดเวลาถ่ายรูป/ });
    const t = tokens(toggle);
    expect(t).toContain("min-h-11");
    expect(t).toContain("[@media(pointer:fine)]:min-h-9");
    expect(t.some((c) => /^sm:min-h-/.test(c))).toBe(false);
  });
});

// CQ-37 — LABEL STAFF CANNOT OPEN /library.
//
// canViewLibrary is false for label_staff, so library/page.tsx sends them to /dashboard,
// which lands on /overview: the copyright chip on the Overview reloaded the page they were
// on. Their place to deal with a song is the show it sits in — the event page opens
// read-only for them and carries the approver's copyright triage.
describe("the copyright chips go where the viewer can act (CQ-37)", () => {
  const PENDING = ev({ id: "r1", name: "Rights pending", event_date: "2026-10-10", copyrightPending: 2 });
  const REJECTED = ev({ id: "r2", name: "Rights rejected", event_date: "2026-10-11", copyrightRejected: 1 });
  const chip = (name: RegExp) => screen.getByRole("link", { name });

  it("label staff: each chip opens the show", () => {
    mountAt([PENDING, REJECTED], { isLabelStaff: true });
    expect(chip(/รอตรวจลิขสิทธิ์/)).toHaveAttribute("href", "/events/r1");
    expect(chip(/ลิขสิทธิ์ไม่ผ่าน/)).toHaveAttribute("href", "/events/r2");
    expect(chip(/รอตรวจลิขสิทธิ์/).getAttribute("title")).toContain("ไปจัดการที่หน้างาน");
    expect(chip(/ลิขสิทธิ์ไม่ผ่าน/).getAttribute("title")).toContain("ไปจัดการที่หน้างาน");
  });

  it("everyone else (admin, CEO, a band's Ar / member): the chips still open the library", () => {
    mountAt([PENDING, REJECTED]);
    expect(chip(/รอตรวจลิขสิทธิ์/)).toHaveAttribute("href", "/library");
    expect(chip(/ลิขสิทธิ์ไม่ผ่าน/)).toHaveAttribute("href", "/library");
    expect(chip(/รอตรวจลิขสิทธิ์/).getAttribute("title")).toContain("ไปจัดการที่คลังเพลง");
  });
});
