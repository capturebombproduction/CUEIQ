// "งานไหนเลยเกิน 1 เดือนไปแล้ว ลบทิ้งเลย รก" (พี่, 2026-09-28). Shown the cost —
// 37 of 52 events, every approved show among them — he chose to fold them away
// instead. So this pins both halves of that: the old ones are OUT of the way by
// default, and they are still THERE (one tap, or a search, brings them back).
// A fold that hid a search result would be the "exists but invisible" defect
// this project has already paid for four times.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EventRow } from "@/lib/types";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import { EventsList } from "./events-list";

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
