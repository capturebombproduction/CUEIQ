// An APPROVED show has met its deadline: no deadline chip for it (2026-10-27, hunt 9).
// Its setlist is done, and the reminder cron (app/api/cron/reminders) already leaves approved
// shows alone - but an approved show whose deadline had passed still wore the red
// "เลยกำหนดแล้ว" on its own page, the dashboard ticket and stubs, and the Overview board, and
// one inside its last day read "ด่วน! เหลือ N ชม.".
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventRow } from "@/lib/types";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import { DeadlineChip, shownDeadline } from "./deadline-chip";
import { EventHero } from "./event-hero";
import { EventsList } from "./events-list";
import { OverviewClient, type OverviewEvent } from "@/components/overview/overview-client";

const PASSED = "2026-10-20T10:00:00Z";
const IN_5H = "2026-10-27T10:00:00Z";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T05:00:00Z")); // 12:00 Bangkok
});
afterAll(() => vi.useRealTimers());

describe("the deadline chip and an approved show", () => {
  it("says nothing for an approved show, passed or due", () => {
    expect(shownDeadline(PASSED, { status: "approved" })).toBeNull();
    expect(shownDeadline(IN_5H, { status: "approved" })).toBeNull();
    const { container } = render(<DeadlineChip deadline={PASSED} status="approved" />);
    expect(container.textContent).toBe("");
  });

  it("still warns a show not approved yet, and still says nothing for an exempt band", () => {
    expect(shownDeadline(PASSED, { status: "draft" })?.label).toBe("เลยกำหนดแล้ว");
    expect(shownDeadline(PASSED, { status: "pending_review" })?.label).toBe("เลยกำหนดแล้ว");
    expect(shownDeadline(IN_5H, { status: "rejected" })?.tone).toBe("urgent");
    expect(shownDeadline(PASSED, { status: "draft", exempt: true })).toBeNull();
  });

  it("the event page hero", () => {
    const show = {
      id: "e1",
      name: "Show",
      venue: "Hall",
      event_date: "2026-11-04",
      show_start_time: "18:00:00",
      hard_out_time: "19:00:00",
      event_type: "idol",
      deadline: PASSED,
      group: { name: "Band", color: "#A62A1C", exempt_from_deadline: false },
    };
    const { rerender } = render(<EventHero event={{ ...show, status: "approved" }} callTime={null} leadLive />);
    expect(screen.queryByText(/เลยกำหนดแล้ว/)).toBeNull();
    rerender(<EventHero event={{ ...show, status: "draft" }} callTime={null} leadLive />);
    expect(screen.getByText(/เลยกำหนดแล้ว/)).toBeTruthy();
  });

  it("the dashboard: the Next Show ticket and the show stubs", () => {
    const ev = (id: string, event_date: string, status: string) =>
      ({
        id,
        tenant_id: "t1",
        group_id: "g1",
        name: id,
        event_date,
        venue: null,
        event_type: "idol",
        show_start_time: null,
        hard_out_time: null,
        status,
        deadline: PASSED,
        last_run_seconds: null,
        is_template: false,
        is_practice: false,
        created_at: "2026-01-01T00:00:00.000Z",
        groups: { name: "วง", color: null, exempt_from_deadline: false },
      }) as unknown as EventRow & { groups: { name: string; color: string | null } };
    const { unmount } = render(
      <ConfirmProvider>
        <EventsList events={[ev("a", "2026-11-01", "approved"), ev("b", "2026-11-08", "approved")]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    expect(screen.queryByText(/เลยกำหนดแล้ว/)).toBeNull();
    unmount();
    render(
      <ConfirmProvider>
        <EventsList events={[ev("a", "2026-11-01", "draft"), ev("b", "2026-11-08", "draft")]} editableGroupIds={[]} />
      </ConfirmProvider>
    );
    // the ticket for "a" and the stub for "b"
    expect(screen.getAllByText(/เลยกำหนดแล้ว/).length).toBeGreaterThanOrEqual(2);
  });

  it("the Overview board", () => {
    const row = (status: string): OverviewEvent => ({
      id: "o1",
      name: "งาน",
      group_id: "g1",
      group_name: "วง",
      group_color: null,
      exempt_from_deadline: false,
      event_date: "2026-11-01",
      status: status as OverviewEvent["status"],
      deadline: PASSED,
      stage: { start: "19:00", end: "19:30" },
      booth: null,
      photo: null,
      photoEnd: null,
      tenant_id: "t1",
      canEditPhoto: false,
      photoItemId: null,
      photoSortOrder: 0,
      copyrightPending: 0,
      copyrightRejected: 0,
      incomplete: 0,
      missingLabels: [],
      notes: null,
    });
    const board = (status: string) => (
      <OverviewClient
        events={[row(status)]}
        bands={[{ id: "g1", name: "วง", color: null, contact_name: null, contact_phone: null, members: [] }]}
        staffContacts={[]}
        labelName="A Lot Of Tone"
        canApproveEvents={false}
        isLabelWide
        canOpenDetail
      />
    );
    const { rerender } = render(board("approved"));
    expect(screen.queryByText(/เลยกำหนดแล้ว/)).toBeNull();
    rerender(board("draft"));
    expect(screen.getAllByText(/เลยกำหนดแล้ว/).length).toBeGreaterThan(0);
  });
});
