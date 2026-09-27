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

  it("a search that matches only a folded event shows it instead of 'ไม่พบ'", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText(/ค้นหางาน/), {
      target: { value: "กรกฎา" },
    });
    expect(screen.getByText("โชว์เดือนกรกฎา")).toBeTruthy();
    expect(screen.queryByText(/ไม่พบงาน/)).toBeNull();
  });
});
