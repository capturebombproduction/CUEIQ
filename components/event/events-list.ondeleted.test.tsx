// A delete drops the card from EventsList's own copy at once - but the PAGE above it kept the
// old list. On the desktop the page builds the ticket's call times from that list
// (cachedCallTimes), so after deleting the ticket's show the next one could be judged against
// the deleted show's cache and print "นัด —". EventsList now tells its parent (onDeleted), and
// the desktop dashboard drops the show from the list it computes the call times from.
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
// The real button confirms and writes; what is under test is what happens AFTER it says "gone".
vi.mock("@/components/event/delete-event-button", () => ({
  DeleteEventButton: ({ eventId, onDeleted }: { eventId: string; onDeleted?: (id: string) => void }) => (
    <button type="button" onClick={() => onDeleted?.(eventId)}>
      ลบ {eventId}
    </button>
  ),
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
    show_start_time: "19:00:00",
    hard_out_time: null,
    status: "approved",
    deadline: null,
    last_run_seconds: null,
    is_template: false,
    is_practice: false,
    created_at: "2026-01-01T00:00:00.000Z",
    groups: { name: "วงทดสอบ", color: null },
  }) as unknown as EventRow & { groups: { name: string; color: string | null } };

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T05:00:00Z"));
});
afterAll(() => vi.useRealTimers());

describe("EventsList · a delete is reported to the page", () => {
  it("calls onDeleted with the id after the card's own delete, and drops the card", () => {
    const onDeleted = vi.fn();
    render(
      <ConfirmProvider>
        <EventsList
          events={[ev("a", "โชว์แรก", "2026-10-03"), ev("b", "โชว์สอง", "2026-10-10")]}
          editableGroupIds={["g1"]}
          onDeleted={onDeleted}
        />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getAllByRole("button", { name: "ลบ a" })[0]);
    expect(onDeleted).toHaveBeenCalledWith("a");
    expect(screen.queryAllByRole("button", { name: "ลบ a" })).toHaveLength(0);
  });
});
