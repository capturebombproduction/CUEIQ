// The Overview board as the redesign lays it out (FINAL-SPEC-v2 §G.7): today first,
// the shows still to come as stubs in each band's colour, the past folded away, and
// quick-filter tiles that show exactly what they count. The approval queue keeps its
// own pins in overview-client.test.tsx; this file pins what the layout changed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";
import { hexToHsl } from "@/lib/skin";

vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SEISHIN = "11111111-1111-4111-8111-111111111111";
const HOSHI = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-10-01"; // a Thursday
const EMOJI = /\p{Extended_Pictographic}|️/u;

function ev(over: Partial<OverviewEvent> & { id: string }): OverviewEvent {
  return {
    name: "งาน",
    group_id: SEISHIN,
    group_name: "Seishin Kakumei",
    group_color: "#A62A1C",
    exempt_from_deadline: false,
    event_date: "2026-10-04",
    status: "approved",
    deadline: null,
    stage: { start: "18:00", end: "18:40" },
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
  { id: SEISHIN, name: "Seishin Kakumei", color: "#A62A1C", contact_name: null, contact_phone: null, members: [] },
  { id: HOSHI, name: "Hoshizora Drops", color: null, contact_name: null, contact_phone: null, members: [] },
];

const ONEMAN = ev({
  id: "oneman",
  name: "SEISHIN KAKUMEI 1st Oneman Live — RED REVOLUTION",
  event_date: "2026-10-04",
});
const PAST = ev({ id: "past", name: "Vasa seitan", event_date: "2026-09-20" });

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
      todayKey={TODAY}
    />
  );
}

/** The off-screen block the JPG is captured from (client-only, aria-hidden). */
const exportBlock = (c: HTMLElement) => c.querySelector<HTMLElement>("div.fixed[aria-hidden]")!;

afterEach(() => cleanup());

describe("today first, the past folded", () => {
  it("puts a show that already happened inside a closed fold, and an upcoming one on the board", () => {
    mount([PAST, ONEMAN]);
    const past = screen.getByRole("link", { name: "Vasa seitan" }).closest("details");
    expect(past).not.toBeNull();
    expect(past!.open).toBe(false);
    expect(past!.querySelector("summary")!.textContent).toMatch(/Past\s*1\s*งานที่ผ่านไปแล้ว/);

    const upcoming = screen.getByRole("link", { name: ONEMAN.name });
    expect(upcoming.closest("details")).toBeNull();
  });

  it("exports what is on screen: no past shows while the fold is shut, all of them once it is open", () => {
    const { container } = mount([PAST, ONEMAN]);
    expect(exportBlock(container).textContent).toContain(ONEMAN.name);
    expect(exportBlock(container).textContent).not.toContain("Vasa seitan");

    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(exportBlock(container).textContent).toContain("Vasa seitan");
  });

  // The queue's whole point is the submission whose date has passed (the cron cannot
  // reach it). Folding must not hide it from the one view built to find it.
  it("the approval queue reaches into the past: its rows come out of the fold", () => {
    const gorya = ev({ id: "gorya", name: "Gorya seitan sai", event_date: "2026-07-19", status: "pending_review" });
    mount([gorya, PAST, ONEMAN]);
    expect(screen.getByRole("link", { name: "Gorya seitan sai" }).closest("details")).not.toBeNull();

    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(screen.getByRole("link", { name: "Gorya seitan sai" }).closest("details")).toBeNull();
    expect(screen.queryByRole("link", { name: "Vasa seitan" })).toBeNull();
  });
});

describe("the Today hero", () => {
  it("lists today's shows with their stage time", () => {
    mount([ev({ id: "t", name: "Idol Paradise vol.12", event_date: TODAY, stage: { start: "14:30", end: null } }), ONEMAN]);
    const hero = screen.getByRole("region", { name: "วันนี้" });
    expect(hero.textContent).toMatch(/Today · Thu 01 Oct/);
    expect(hero.textContent).toMatch(/1\s*โชว์วันนี้/);
    expect(within(hero).getByRole("link", { name: "Idol Paradise vol.12" })).toBeTruthy();
    expect(hero.textContent).toContain("14:30");
  });

  it("with nothing today, says how far off the next show is and names it on the slab", () => {
    mount([PAST, ONEMAN]);
    const hero = screen.getByRole("region", { name: "วันนี้" });
    expect(hero.textContent).toContain("ไม่มีโชว์วันนี้");
    expect(hero.textContent).toMatch(/อีก\s*3\s*วัน/);
    expect(within(hero).getByText("RED REVOLUTION").className).toContain("title-slab");
  });
});

describe("the quick-filter tiles", () => {
  const MISSING = ev({ id: "m", name: "Japan Expo — Idol Stage", event_date: "2026-10-11", status: "draft", incomplete: 2 });
  const READY = ev({ id: "r", name: "Ready show", event_date: "2026-10-12", group_id: HOSHI, group_name: "Hoshizora Drops" });
  const OLD_MISSING = ev({ id: "o", name: "Old draft", event_date: "2026-09-01", status: "draft", incomplete: 1 });

  it("counts only shows still to come, and filters the board to exactly those", () => {
    mount([MISSING, READY, OLD_MISSING]);
    const tile = screen.getByRole("button", { name: /ยังเตรียมไม่ครบ/ });
    expect(tile.textContent).toMatch(/^1/);
    expect(tile).toHaveAttribute("aria-pressed", "false");

    // A band filter first: the tile must clear it, like the queue does.
    const bandSelect = screen.getByRole("combobox", { name: "เลือกวง" }) as HTMLSelectElement;
    fireEvent.change(bandSelect, { target: { value: HOSHI } });

    fireEvent.click(tile);
    expect(screen.getByRole("button", { name: /ยังเตรียมไม่ครบ/ })).toHaveAttribute("aria-pressed", "true");
    expect(bandSelect.value).toBe("all");
    expect(screen.getByRole("link", { name: MISSING.name })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ready show" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Old draft" })).toBeNull();
  });

  it("a tile with nothing to show cannot be pressed into an empty board", () => {
    mount([READY]);
    expect(screen.getByRole("button", { name: /ติดลิขสิทธิ์/ })).toBeDisabled();
  });
});

describe("stubs read in date order", () => {
  // A band's section (รายวง, the default) collects every date that band plays, and
  // each stub now LEADS with its date tile — so a later date with an earlier clock
  // must not jump ahead of the show that comes first. Same for the Photo and Booth
  // tables and the JPG, which the on-screen tables promise to match.
  const EARLY = ev({
    id: "early",
    name: "First on the calendar",
    event_date: "2026-10-04",
    stage: { start: "18:00", end: null },
    photo: "17:00",
    booth: { start: "19:00", end: null },
  });
  const LATER = ev({
    id: "later",
    name: "Later on the calendar",
    event_date: "2026-10-10",
    stage: { start: "12:00", end: null },
    photo: "11:00",
    booth: { start: "13:00", end: null },
  });
  /** Show names of the stubs, in document order. */
  const stubNames = (root: ParentNode) =>
    Array.from(root.querySelectorAll("li.stub")).map((li) => li.querySelector("a")?.textContent);
  /** Show names in one of the on-screen mini tables ("Photo" / "Booth"). */
  const miniTableNames = (title: string) =>
    Array.from(
      screen
        .getByText(title, { selector: "span.eyebrow" })
        .closest("div.overflow-hidden")!
        .querySelectorAll("tr a")
    ).map((a) => a.textContent);

  it("upcoming: the earlier date first, even when the later date starts earlier in the day", () => {
    const { container } = mount([LATER, EARLY]);
    expect(stubNames(container)).toEqual([EARLY.name, LATER.name]);
    expect(miniTableNames("Photo")).toEqual([EARLY.name, LATER.name]);
    expect(miniTableNames("Booth")).toEqual([EARLY.name, LATER.name]);
    // Every column of the exported image in the same order.
    const tables = Array.from(exportBlock(container).querySelectorAll("table"));
    expect(tables).toHaveLength(3);
    for (const t of tables) {
      const firsts = Array.from(t.querySelectorAll("tr")).map((tr) => tr.querySelector("td")!.textContent);
      expect(firsts[0]).toContain(EARLY.name);
      expect(firsts[1]).toContain(LATER.name);
    }
  });

  it("the Past fold: most recent first, even when the older show started earlier in the day", () => {
    const OLDER = ev({ id: "older", name: "Older past show", event_date: "2026-09-20", stage: { start: "12:00", end: null } });
    const RECENT = ev({ id: "recent", name: "Recent past show", event_date: "2026-09-28", stage: { start: "18:00", end: null } });
    const { container } = mount([OLDER, RECENT, ONEMAN]);
    expect(stubNames(container.querySelector("details")!)).toEqual([RECENT.name, OLDER.name]);
  });
});

// The show name's link carries an invisible ::after that grows its tap area 13 px up
// and down (HIT_NAME). jsdom has no layout, so these pin the two classes that keep that
// box in its lane — measured in headless Chrome when they were added: without them a
// phone tap 1–3 px into a wrapped photo-time field opened the event instead, and the
// last row's box poked 3 px out of the table, giving every Photo/Booth table a
// vertical scrollbar on a Windows laptop.
describe("the name's enlarged tap area stays in its lane", () => {
  const PHOTO = ev({
    id: "p",
    name: "SEISHIN KAKUMEI 1st Oneman Live — RED REVOLUTION",
    photo: "17:00",
    canEditPhoto: true,
    booth: { start: "19:00", end: null },
  });

  it("the photo-time field stacks above the name's tap area when the row wraps", () => {
    mount([PHOTO]);
    const start = screen.getByLabelText("เวลาเริ่มถ่ายรูป");
    expect(start.closest("td")!.className.split(/\s+/)).toContain("relative");
  });

  it("the Photo and Booth tables never scroll vertically by the overhang", () => {
    mount([PHOTO]);
    for (const title of ["Photo", "Booth"]) {
      const scroller = screen
        .getByText(title, { selector: "span.eyebrow" })
        .closest("div.overflow-hidden")!
        .querySelector("div.overflow-x-auto")!;
      expect(scroller.className.split(/\s+/)).toContain("overflow-y-hidden");
    }
  });
});

describe("show stubs", () => {
  it("paint the date tile in the band's own colour, with a fallback for a band that has none", () => {
    const hoshi = ev({ id: "h", name: "Hoshi live", group_id: HOSHI, group_name: "Hoshizora Drops", group_color: null });
    mount([ONEMAN, hoshi]);
    const { h, s, l } = hexToHsl("#A62A1C");
    const stubOf = (name: string) => screen.getByRole("link", { name }).closest("li")!;
    expect(stubOf(ONEMAN.name).style.getPropertyValue("--band")).toBe(`${h} ${s}% ${l}%`);
    expect(stubOf("Hoshi live").style.getPropertyValue("--band")).toBe("var(--muted-foreground)");
    expect(stubOf(ONEMAN.name).querySelector(".date-tile")!.textContent).toMatch(/Sun\s*04\s*Oct/);
    // One status control per show — not one per breakpoint.
    expect(screen.getAllByTitle(/แตะเพื่อเปลี่ยนสถานะ/)).toHaveLength(2);
  });

  it("flag rights and missing prep with an icon and a word, never an emoji", () => {
    mount([ev({ id: "x", name: "Flagged", status: "draft", copyrightRejected: 2, incomplete: 3 })]);
    const stub = screen.getByRole("link", { name: "Flagged" }).closest("li")!;
    const rights = within(stub).getByRole("link", { name: /ลิขสิทธิ์ไม่ผ่าน/ });
    const missing = within(stub).getByRole("link", { name: /ยังขาด/ });
    for (const chip of [rights, missing]) {
      expect(chip.querySelector("svg")).not.toBeNull();
      expect(chip.textContent).not.toMatch(EMOJI);
    }
    expect(rights.textContent).toMatch(/ลิขสิทธิ์ไม่ผ่าน\s*2/);
    expect(missing.textContent).toMatch(/ยังขาด\s*3/);
  });
});
