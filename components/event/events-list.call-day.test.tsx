// The Next Show ticket's day word, for a show called the evening BEFORE its date.
// 2026-10-30, hunt 11: the word counted to event_date alone, so on the day of a 22:30 call
// for a 00:30 stage the ticket read "พรุ่งนี้ · นัด 22:30" - a member who believed it came a
// day late. Before the date the word now counts to the call (lib/next-show.ts callDayOffset):
// "คืนนี้" on the call's day, "พรุ่งนี้" the day before; on the date itself still "วันนี้".
// Every ordinary show - both real shows of 10-31 and 11-01 among them - reads as before.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import type { EventRow } from "@/lib/types";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import { EventsList } from "./events-list";

const ev = (id: string, name: string, event_date: string, show_start_time: string) =>
  ({
    id,
    tenant_id: "t1",
    group_id: "g1",
    name,
    event_date,
    venue: null,
    event_type: "idol",
    show_start_time,
    hard_out_time: null,
    status: "approved",
    deadline: null,
    last_run_seconds: null,
    is_template: false,
    is_practice: false,
    created_at: "2026-01-01T00:00:00.000Z",
    groups: { name: "Seishin Kakumei", color: null },
  }) as unknown as EventRow & { groups: { name: string; color: string | null } };

/** The ticket's day line (the row holding the big word and the date tile), as text. */
function ticketOn(utcInstant: string, events: ReturnType<typeof ev>[], callTimes: Record<string, string>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(utcInstant));
  render(
    <ConfirmProvider>
      <EventsList events={events} editableGroupIds={[]} callTimes={callTimes} />
    </ConfirmProvider>
  );
  const ticket = within(screen.getByRole("region", { name: "Next show" }));
  return ticket;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HALLOWEEN = ev("halloween", "Ichiban idol vol.26 Halloween", "2026-10-31", "17:40:00");
const REBORN = ev("reborn", "Reborn into into a new me", "2026-11-01", "13:40:00");
const REAL_CALLS = { halloween: "17:25:00", reborn: "13:25:00" };

describe("the ticket's day word, real shows (unchanged)", () => {
  it("10-31's show on 10-30 reads พรุ่งนี้", () => {
    const t = ticketOn("2026-10-30T05:00:00Z", [HALLOWEEN, REBORN], REAL_CALLS);
    expect(t.getByText("พรุ่งนี้")).toBeTruthy();
    expect(t.queryByText("คืนนี้")).toBeNull();
  });

  it("10-31's show on its day reads วันนี้ with its stage time", () => {
    const t = ticketOn("2026-10-31T05:00:00Z", [HALLOWEEN, REBORN], REAL_CALLS);
    expect(t.getByText("วันนี้")).toBeTruthy();
    expect(t.getAllByText("17:40").length).toBeGreaterThan(0);
  });

  it("11-01's show, two days out, reads อีก 2 วัน", () => {
    const t = ticketOn("2026-10-30T05:00:00Z", [REBORN], REAL_CALLS);
    expect(t.getByText("อีก")).toBeTruthy();
    expect(t.getByText("2")).toBeTruthy();
    expect(t.queryByText("พรุ่งนี้")).toBeNull();
  });
});

describe("the ticket's day word, a show called the evening before its date", () => {
  const NYE = ev("nye", "Countdown Afterparty", "2027-01-01", "00:30:00");
  const CALLS = { nye: "22:30:00" };

  it("on the call's day (Dec 31) it reads คืนนี้, not พรุ่งนี้", () => {
    const t = ticketOn("2026-12-31T05:00:00Z", [NYE], CALLS);
    expect(t.getByText("คืนนี้")).toBeTruthy();
    expect(t.queryByText("พรุ่งนี้")).toBeNull();
  });

  it("the day before the call (Dec 30) it reads พรุ่งนี้, not อีก 2 วัน", () => {
    const t = ticketOn("2026-12-30T05:00:00Z", [NYE], CALLS);
    expect(t.getByText("พรุ่งนี้")).toBeTruthy();
    expect(t.queryByText("อีก")).toBeNull();
  });

  it("after midnight, on its own date, it reads วันนี้", () => {
    const t = ticketOn("2026-12-31T17:10:00Z", [NYE], CALLS); // 00:10 Bangkok, Jan 1
    expect(t.getByText("วันนี้")).toBeTruthy();
  });
});
