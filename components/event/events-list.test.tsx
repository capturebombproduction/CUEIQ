// "งานไหนเลยเกิน 1 เดือนไปแล้ว ลบทิ้งเลย รก" (พี่, 2026-09-28). Shown the cost —
// 37 of 52 events, every approved show among them — he chose to fold them away
// instead. So this pins both halves of that: the old ones are OUT of the way by
// default, and they are still THERE (one tap, or a search, brings them back).
// A fold that hid a search result would be the "exists but invisible" defect
// this project has already paid for four times.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EventRow } from "@/lib/types";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import { EventsList, compareUpcoming, nextTicketShow } from "./events-list";

const ev = (id: string, name: string, event_date: string) =>
  ({
    id,
    tenant_id: "t1",
    group_id: "g1",
    name,
    event_date,
    venue: null,
    event_type: "idol",
    show_start_time: null,
    hard_out_time: null,
    status: "approved",
    deadline: null,
    last_run_seconds: null,
    is_template: false,
    is_practice: false,
    created_at: "2026-01-01T00:00:00.000Z",
    groups: { name: "วงทดสอบ", color: null },
  }) as unknown as EventRow & { groups: { name: string; color: string | null } };

// Today is 2026-09-28 in Bangkok → the fold starts before 2026-08-28.
const events = [
  ev("up", "โชว์ที่จะถึง", "2026-10-05"),
  ev("recent", "โชว์เพิ่งผ่าน", "2026-08-28"),
  ev("old", "โชว์เดือนกรกฎา", "2026-07-19"),
];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T05:00:00Z")); // 12:00 Bangkok
});
afterAll(() => vi.useRealTimers());

const mount = () =>
  render(
    <ConfirmProvider>
      <EventsList events={events} editableGroupIds={[]} />
    </ConfirmProvider>
  );

describe("EventsList — events more than a month past fold away", () => {
  it("keeps upcoming and last month's shows on the page, folds the older one", () => {
    mount();
    // (twice: the "next show" banner and its card)
    expect(screen.getAllByText("โชว์ที่จะถึง").length).toBeGreaterThan(0);
    // exactly one month back is still "recent", not folded
    expect(screen.getByText("โชว์เพิ่งผ่าน")).toBeTruthy();
    expect(screen.queryByText("โชว์เดือนกรกฎา")).toBeNull();
    const fold = screen.getByRole("button", { name: /งานเก่า \(เกิน 1 เดือน\) · 1/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });

  it("one tap opens the fold, another closes it — nothing was deleted", () => {
    mount();
    const fold = screen.getByRole("button", { name: /งานเก่า/ });
    fireEvent.click(fold);
    expect(screen.getByText("โชว์เดือนกรกฎา")).toBeTruthy();
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(screen.queryByText("โชว์เดือนกรกฎา")).toBeNull();
  });

  // 2026-09-28: the ONLY card under กำลังจะถึง was a dateless test event from July.
  it("a show with no date sits under its own heading, not under กำลังจะถึง", () => {
    render(
      <ConfirmProvider>
        <EventsList
          events={[...events, ev("nodate", "เทสงานค่าย", null as unknown as string)]}
          editableGroupIds={[]}
        />
      </ConfirmProvider>
    );
    const upcomingHeading = screen.getByText(/^กำลังจะถึง · 1$/);
    const undatedHeading = screen.getByText(/^ยังไม่ได้ใส่วันที่ · 1$/);
    const card = screen.getByText("เทสงานค่าย");
    // the card belongs to the undated section, not the upcoming one
    expect(undatedHeading.closest("section")!.contains(card)).toBe(true);
    expect(upcomingHeading.closest("section")!.contains(card)).toBe(false);
  });

  // The desktop's offline dashboard renders cached rows that may lack event_type;
  // shortening the type label once called .split() on undefined and took the
  // whole list down (caught by the airplane smoke boot, 2026-09-28).
  it("renders a card whose row has no event_type instead of crashing", () => {
    const bare = { ...ev("bare", "แคชไม่มีประเภทงาน", "2026-10-05") } as Record<string, unknown>;
    delete bare.event_type;
    render(
      <ConfirmProvider>
        <EventsList events={[bare as never]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    expect(screen.getAllByText("แคชไม่มีประเภทงาน").length).toBeGreaterThan(0);
  });

  it("a search that matches only a folded event shows it instead of 'ไม่พบ'", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText(/ค้นหางาน/), {
      target: { value: "กรกฎา" },
    });
    expect(screen.getByText("โชว์เดือนกรกฎา")).toBeTruthy();
    expect(screen.queryByText(/ไม่พบงาน/)).toBeNull();
  });
});

// The "งานถัดไป" banner, 2026-10-01 (lib/next-show.ts). Measured: the band is
// called ~2 h before its set, and the banner printed only the set time — the one
// time a member need not be anywhere by. And its bright second button was Live
// Mode, which only an admin can drive; the band practises the next show's set.
describe("EventsList — the next-show banner says when to BE there", () => {
  const next = { ...ev("up", "โชว์ที่จะถึง", "2026-10-05"), show_start_time: "13:20:00" };
  const mountBanner = (props: Partial<Parameters<typeof EventsList>[0]> = {}) =>
    render(
      <ConfirmProvider>
        <EventsList events={[next]} editableGroupIds={[]} {...props} />
      </ConfirmProvider>
    );

  it("gives the call time and the stage time", () => {
    mountBanner({ callTimes: { up: "11:20:00" } });
    expect(screen.getByTestId("next-show-times").textContent).toBe("นัด 11:20 · ขึ้นเวที 13:20");
  });

  it("without schedules (the desktop's offline list) still names the stage time as such", () => {
    mountBanner();
    expect(screen.getByTestId("next-show-times").textContent).toBe("ขึ้นเวที 13:20");
  });

  it("an admin keeps Live Mode", () => {
    mountBanner({ canRunLive: true });
    expect(screen.getByRole("link", { name: /Live Mode/ }).getAttribute("href")).toBe("/events/up/live");
    expect(screen.queryByRole("link", { name: /ซ้อม/ })).toBeNull();
  });

  it("everyone else gets ซ้อม, straight into the room the band practises in", () => {
    mountBanner({ canRunLive: false, practiceRoomByGroup: { g1: "room-1" } });
    expect(screen.getByRole("link", { name: /ซ้อม/ }).getAttribute("href")).toBe("/events/room-1/practice");
    expect(screen.queryByRole("link", { name: /Live Mode/ })).toBeNull();
  });

  it("on the show's own day it is Live Mode for everyone — that is what the day is for", () => {
    render(
      <ConfirmProvider>
        <EventsList
          events={[{ ...next, event_date: "2026-09-28" }]}
          editableGroupIds={[]}
          canRunLive={false}
          practiceRoomByGroup={{ g1: "room-1" }}
        />
      </ConfirmProvider>
    );
    expect(screen.getByRole("link", { name: /Live Mode/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /ซ้อม/ })).toBeNull();
  });

  it("label staff (desktop — the web redirects them) never get ซ้อม: practice is a band activity", () => {
    mountBanner({ canRunLive: false, canPractice: false });
    expect(screen.queryByRole("link", { name: /ซ้อม/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Live Mode/ })).toBeTruthy();
  });

  it("with no room known, ซ้อม opens the Training list", () => {
    mountBanner({ canRunLive: false });
    expect(screen.getByRole("link", { name: /ซ้อม/ }).getAttribute("href")).toBe("/practice");
  });
});

// The redesign's ticket and stubs (spec §G.1) read more of each row than the old
// cards did — the band colour for the date tile, the date in parts, the times for
// the stub. The desktop renders the list from its offline cache, whose rows carry
// only what the airplane smoke seeds (desktop/scripts/smoke-backend.mjs): no
// event_type, no times, no deadline, no run time, and a band with no colour. The
// .exe smoke fails on any console.error, so this asserts the same thing in jsdom.
describe("EventsList — the redesign survives a bare cached row", () => {
  const seedRow = (id: string, name: string, event_date: string | null) =>
    ({
      id,
      tenant_id: "t1",
      group_id: "g1",
      name,
      event_date,
      venue: null,
      status: "draft",
      is_template: false,
      is_practice: false,
      created_at: "2026-01-01T00:00:00.000Z",
      groups: { name: "วงทดสอบ", color: null, exempt_from_deadline: false },
    }) as never;

  it("draws the ticket and the stubs, with no console error", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ConfirmProvider>
          <EventsList
            events={[
              seedRow("next", "โชว์ถัดไปจากแคช", "2026-10-03"),
              seedRow("later", "โชว์หลังจากนั้น", "2026-11-20"),
              seedRow("gone", "โชว์ที่ผ่านไปแล้ว", "2026-09-10"),
            ]}
            editableGroupIds={["g1"]}
            canRunLive={false}
          />
        </ConfirmProvider>
      );
      const ticket = screen.getByRole("region", { name: "Next show" });
      expect(ticket).toHaveTextContent("โชว์ถัดไปจากแคช");
      expect(ticket).toHaveTextContent("อีก5วัน");
      // the stub's date tile: weekday, day, month — and it is a link into the show
      const later = screen.getByRole("link", { name: /โชว์หลังจากนั้น/ });
      expect(later).toHaveAttribute("href", "/events/later");
      expect(later).toHaveTextContent(/Fri\s*20\s*Nov/);
      expect(screen.getByRole("link", { name: /โชว์ที่ผ่านไปแล้ว/ })).toBeInTheDocument();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("a show 120 days out sets its count smaller, so three digits fit a phone", () => {
    render(
      <ConfirmProvider>
        <EventsList events={[seedRow("far", "โชว์ไกล", "2027-01-26")]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    const count = screen.getByText("120");
    expect(count.className.split(" ")).toContain("text-[96px]");
  });

  it("What's New goes under the ticket, never above it", () => {
    render(
      <ConfirmProvider>
        <EventsList
          events={[seedRow("next", "โชว์ถัดไปจากแคช", "2026-10-03")]}
          editableGroupIds={[]}
          belowHero={<p>การ์ดมีอะไรใหม่</p>}
        />
      </ConfirmProvider>
    );
    const ticket = screen.getByRole("region", { name: "Next show" });
    const card = screen.getByText("การ์ดมีอะไรใหม่");
    expect(ticket.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// Between shows (2026-10-01: Seishin had none entered — they enter a show 1–3
// days before it). Without a next show there was no banner, and with it went the
// one-tap "ซ้อม" in exactly the days the band practises.
describe("EventsList — between shows", () => {
  const past = ev("p", "โชว์ที่ผ่านมา", "2026-09-20");
  const mountPast = (props: Partial<Parameters<typeof EventsList>[0]> = {}) =>
    render(
      <ConfirmProvider>
        <EventsList events={[past]} editableGroupIds={[]} {...props} />
      </ConfirmProvider>
    );

  it("says there is no next show, and keeps ซ้อม one tap away — into the band's room", () => {
    mountPast({ canRunLive: false, practiceRoomByGroup: { g1: "room-1" } });
    expect(screen.getByTestId("no-next-show")).toHaveTextContent("ยังไม่มีงานที่จะถึงในระบบ");
    expect(screen.getByRole("link", { name: /ซ้อม/ }).getAttribute("href")).toBe("/events/room-1/practice");
  });

  it("with rooms in several bands, ซ้อม opens the Training list", () => {
    mountPast({ canRunLive: false, practiceRoomByGroup: { g1: "room-1", g2: "room-2" } });
    expect(screen.getByRole("link", { name: /ซ้อม/ }).getAttribute("href")).toBe("/practice");
  });

  it("not for an admin, nor for label staff", () => {
    const { unmount } = mountPast({ canRunLive: true });
    expect(screen.queryByTestId("no-next-show")).toBeNull();
    unmount();
    mountPast({ canRunLive: false, canPractice: false });
    expect(screen.queryByTestId("no-next-show")).toBeNull();
  });

  it("not while searching — the list is the answer then", () => {
    mountPast({ canRunLive: false });
    fireEvent.change(screen.getByPlaceholderText(/ค้นหา/), { target: { value: "โชว์" } });
    expect(screen.queryByTestId("no-next-show")).toBeNull();
  });
});

// §J Home, 2026-10-01: the first Upcoming stub is the ticket's own show, and it
// repeated the ticket's deadline chip on a line of its own — 123 px of stub that
// pushed the first row under a member's tab bar (bottom 731.5, target ≤ 705).
describe("EventsList — the ticket's own stub does not repeat its deadline", () => {
  const next = { ...ev("up", "โชว์ที่จะถึง", "2026-10-05"), deadline: "2026-09-30T05:00:00Z" };
  const later = { ...ev("later", "โชว์ถัดไปอีก", "2026-10-20"), deadline: "2026-10-15T05:00:00Z" };
  const stubOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLAnchorElement>(`a.stub[href="/events/${id}"]`)!;

  it("says the deadline once, on the ticket; other stubs keep theirs", () => {
    const { container } = render(
      <ConfirmProvider>
        <EventsList events={[later, next]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    const ticket = screen.getByRole("region", { name: "Next show" });
    expect(ticket.textContent).toContain("เหลือ 2 วัน");
    expect(screen.getAllByText("เหลือ 2 วัน")).toHaveLength(1);
    expect(stubOf(container, "up").textContent).not.toContain("เหลือ 2 วัน");
    expect(stubOf(container, "later").textContent).toContain("ครบกำหนด");
  });

  it("while searching there is no ticket, so the stub carries it again", () => {
    const { container } = render(
      <ConfirmProvider>
        <EventsList events={[later, next]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/ค้นหางาน/), { target: { value: "โชว์ที่จะถึง" } });
    expect(screen.queryByRole("region", { name: "Next show" })).toBeNull();
    expect(stubOf(container, "up").textContent).toContain("เหลือ 2 วัน");
  });
});

// CQ-56 (round 15). On a touch screen an editor's past row reserves 108 px for the
// always-showing copy/delete buttons, and the name sat in a single-line `truncate`
// in what was left — about ten characters. It wraps onto a second line now.
//
// Geometry cannot be measured in jsdom (no layout engine); the real-browser check
// is the harness at 360/390 as an admin. What jsdom guards is the class contract,
// including the trap that Tailwind emits `.block` AFTER `.line-clamp-2`: a stray
// `block` replaces the clamp's display and it silently stops clamping.
describe("EventsList — a past row's show name wraps instead of being cut (CQ-56)", () => {
  const LONG = "Bangkok Idol Festival 2026";

  it.each([
    ["an editor (copy/delete buttons reserve the row's right edge)", ["g1"]],
    ["a viewer", []],
  ])("for %s", (_who, editable) => {
    render(
      <ConfirmProvider>
        <EventsList events={[ev("p", LONG, "2026-09-20")]} editableGroupIds={editable} />
      </ConfirmProvider>
    );
    const name = screen.getByRole("heading", { name: LONG });
    expect(name.className).toContain("line-clamp-2");
    expect(name.className).toContain("break-words");
    expect(name.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(name.className).not.toMatch(/(^|\s)block(\s|$)/);
  });
});

// CQ-55 (round 15, approved by the owner). A stub's title sat in a one-line `truncate`
// at every width, so on a tablet or the desktop app (1280) a long festival name was cut
// with the rest of the card empty. From sm up it may take two lines; a phone keeps the
// single line (the stub list there is capped to fit above the tab bar, spec §J), and the
// full name is on hover either way. The stub has no fixed height — the card grows with
// its content and the grid row stretches its neighbours — so a second line cannot clip
// the date tile, the venue or the corner buttons.
//
// jsdom has no layout engine; this guards the class contract, including the trap that
// `block` would replace the clamp's display and stop it clamping. The geometry is the
// lead's real-browser measurement (sm / lg / 1280, a name long enough to need two lines).
describe("EventsList — a long stub title takes two lines from sm up (CQ-55)", () => {
  const LONG = "Bangkok Idol Festival 2026 Grand Finale and Closing Ceremony";
  const mountStub = (editable: string[]) => {
    const { container } = render(
      <ConfirmProvider>
        <EventsList
          events={[ev("next", "โชว์ที่จะถึง", "2026-10-05"), ev("long", LONG, "2026-10-20")]}
          editableGroupIds={editable}
        />
      </ConfirmProvider>
    );
    return container.querySelector<HTMLAnchorElement>('a.stub[href="/events/long"]')!.querySelector("h3")!;
  };

  it.each([
    ["an editor", ["g1"]],
    ["a viewer", []],
  ])("clamps to two lines from sm up and stays one line on a phone, for %s", (_who, editable) => {
    const name = mountStub(editable);
    // phone: the single-line cut stays
    expect(name.className).toMatch(/(^|\s)truncate(\s|$)/);
    // sm and up: the nowrap is undone, two lines, and a long unbroken word may break
    expect(name.className).toMatch(/(^|\s)sm:whitespace-normal(\s|$)/);
    expect(name.className).toMatch(/(^|\s)sm:line-clamp-2(\s|$)/);
    expect(name.className).toContain("sm:[overflow-wrap:anywhere]");
    expect(name.className).not.toMatch(/(^|\s)(sm:)?block(\s|$)/);
  });

  it("carries the full name on hover", () => {
    expect(mountStub([]).getAttribute("title")).toBe(LONG);
  });
});

// CQ-57 (round 15). The ticket's second button said "ซ้อมตามเซ็ต" — the word for the
// band's ROOM — even when the band has none and the link falls back to the Training
// list. The event page's hero already says "ห้องซ้อม" then (components/event/event-hero.tsx).
describe("EventsList — the ticket's practice button names what it opens (CQ-57)", () => {
  const next = ev("up", "โชว์ที่จะถึง", "2026-10-05");
  const mountPractice = (practiceRoomByGroup?: Record<string, string>) =>
    render(
      <ConfirmProvider>
        <EventsList
          events={[next]}
          editableGroupIds={[]}
          canRunLive={false}
          practiceRoomByGroup={practiceRoomByGroup}
        />
      </ConfirmProvider>
    );

  it("with no room for the band it says ห้องซ้อม and opens the Training list", () => {
    mountPractice();
    const link = screen.getByRole("link", { name: "ห้องซ้อม" });
    expect(link.getAttribute("href")).toBe("/practice");
    expect(screen.queryByText("ซ้อมตามเซ็ต")).toBeNull();
  });

  it("a room that belongs to another band does not count as this band's", () => {
    mountPractice({ g2: "room-2" });
    const link = screen.getByRole("link", { name: "ห้องซ้อม" });
    expect(link.getAttribute("href")).toBe("/practice");
  });

  it("with the band's room it says ซ้อมตามเซ็ต and opens that room", () => {
    mountPractice({ g1: "room-1" });
    const link = screen.getByRole("link", { name: "ซ้อมตามเซ็ต" });
    expect(link.getAttribute("href")).toBe("/events/room-1/practice");
    expect(screen.queryByRole("link", { name: "ห้องซ้อม" })).toBeNull();
  });
});

// CQ-65 (round 15). The desktop dashboard passes no callTimes (its list cache has no
// schedules), and the ticket printed "นัด —" for every show — which reads as "this
// show has no call time" when the truth is "this device does not know". Absent
// callTimes now leaves the cell out; a map (even an empty one) means it was read.
describe("EventsList — the ticket's นัด cell says what is known (CQ-65)", () => {
  const next = { ...ev("up", "โชว์ที่จะถึง", "2026-10-05"), show_start_time: "13:20:00" };
  const mountTicket = (callTimes?: Record<string, string>) => {
    render(
      <ConfirmProvider>
        <EventsList events={[next]} editableGroupIds={[]} callTimes={callTimes} />
      </ConfirmProvider>
    );
    return within(screen.getByRole("region", { name: "Next show" }));
  };

  it("leaves the นัด cell out when no callTimes were given — unknown is not 'none'", () => {
    const ticket = mountTicket();
    expect(ticket.queryByText("นัด")).toBeNull();
    // the other two cells stay, on a two-column grid so they do not leave a hole
    expect(ticket.getByText("ขึ้นเวที")).toBeTruthy();
    expect(ticket.getByText("13:20")).toBeTruthy();
    expect(ticket.getByText("Hard Out")).toBeTruthy();
    expect(ticket.getByText("ขึ้นเวที").closest(".grid")!.className).toContain("grid-cols-2");
    expect(ticket.getByText("ขึ้นเวที").closest(".grid")!.className).not.toContain("grid-cols-3");
  });

  it("prints the call time when the schedules were read", () => {
    const ticket = mountTicket({ up: "11:20:00" });
    const cell = ticket.getByText("นัด").parentElement!;
    expect(cell.textContent).toContain("11:20");
    expect(ticket.getByText("นัด").closest(".grid")!.className).toContain("grid-cols-3");
  });

  it("an empty map still shows the cell, as — : it was read and this show has no call", () => {
    const ticket = mountTicket({});
    expect(ticket.getByText("นัด").parentElement!.textContent).toBe("นัด—");
  });

  it("keeps the screen-reader line either way, and the stage cell keeps its marker", () => {
    const ticket = mountTicket();
    expect(ticket.getByTestId("next-show-times").textContent).toBe("ขึ้นเวที 13:20");
    // the primary bar before ขึ้นเวที moved with the label, not with a fixed index
    expect(ticket.getByText("ขึ้นเวที").querySelector("i")).not.toBeNull();
  });
});

// CQ-65 (mixed cache): the desktop looks the ticket's call time up in the bundles it
// has cached, and must look up the show the ticket PRINTS — so it asks for it by the
// list's own ordering instead of a copy of the sort that could drift.
describe("nextTicketShow / compareUpcoming — the one show the ticket is about", () => {
  const TODAY = "2026-09-28";
  const row = (id: string, event_date: string | null, show_start_time: string | null = null) => ({
    id,
    event_date,
    show_start_time,
  });

  it("orders soonest date first, then start time, and a dateless show last", () => {
    const rows = [
      row("nodate", null),
      row("late", "2026-10-05", "21:00:00"),
      row("untimed", "2026-10-05"),
      row("early", "2026-10-05", "13:00:00"),
      row("sooner", "2026-10-02", "23:00:00"),
    ];
    expect([...rows].sort(compareUpcoming).map((r) => r.id)).toEqual([
      "sooner",
      "early",
      "late",
      "untimed",
      "nodate",
    ]);
  });

  it("is the soonest dated show that is not past — today counts", () => {
    expect(
      nextTicketShow(
        [row("past", "2026-09-27"), row("nodate", null), row("later", "2026-10-09"), row("today", TODAY)],
        TODAY
      )?.id
    ).toBe("today");
  });

  it("on one day it is the earlier stage time, wherever the list puts it", () => {
    expect(
      nextTicketShow([row("night", "2026-10-05", "21:00:00"), row("early", "2026-10-05", "13:00:00")], TODAY)?.id
    ).toBe("early");
  });

  it("a tie goes to the one listed first (the sort is stable), as in the list", () => {
    expect(
      nextTicketShow([row("a", "2026-10-05", "13:00:00"), row("b", "2026-10-05", "13:00:00")], TODAY)?.id
    ).toBe("a");
  });

  it("is undefined with nothing coming, and leaves the caller's array in its order", () => {
    expect(nextTicketShow([], TODAY)).toBeUndefined();
    expect(nextTicketShow([row("past", "2026-01-01"), row("nodate", null)], TODAY)).toBeUndefined();
    const rows = [row("b", "2026-10-09"), row("a", "2026-10-05")];
    nextTicketShow(rows, TODAY);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("defaults to today's Bangkok date", () => {
    // the file pins the clock to 2026-09-28
    expect(nextTicketShow([row("yesterday", "2026-09-27"), row("today", TODAY)])?.id).toBe("today");
  });

  it("agrees with the ticket EventsList actually prints", () => {
    const list = [
      { ...ev("n", "งานดึก", "2026-10-05"), show_start_time: "21:00:00" },
      { ...ev("p", "งานที่ผ่านไป", "2026-09-01"), show_start_time: "10:00:00" },
      { ...ev("d", "งานไม่มีวัน", null as unknown as string) },
      { ...ev("e", "งานเช้า", "2026-10-05"), show_start_time: "13:00:00" },
      { ...ev("l", "งานไกล", "2026-11-01"), show_start_time: "09:00:00" },
    ];
    render(
      <ConfirmProvider>
        <EventsList events={list} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    const ticket = screen.getByRole("region", { name: "Next show" });
    const picked = nextTicketShow(list);
    expect(picked?.id).toBe("e");
    expect(ticket).toHaveTextContent(picked!.name);
    expect(ticket).not.toHaveTextContent("งานดึก");
  });
});
