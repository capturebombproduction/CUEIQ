// 2026-10-27 hunt (events): c4388cf reads the run sheet's day "round the stage"
// (lib/clone-event.ts dayOrderSeconds = aroundTheClock(anchor, t), -12 h..+12 h). A row
// MORE than 12 h before the show start wraps to the END of the day: a 06:00 morning
// call / rehearsal for an 18:30 show prints after the stage (and after the booth), as if
// it were 06:00 the next morning. Before c4388cf (plain clock order) it printed first.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventRow, Group, ScheduleItem } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { EventSummary } from "@/components/event/event-summary";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
const event = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-31",
  venue: null, event_type: "idol", show_start_time: "18:30:00", hard_out_time: "19:00:00",
  status: "draft", notes: null, map_url: null, costume_theme: null, is_template: false, group,
} as unknown as EventRow & { group: Group | null };
const sched = (id: string, kind: string, start: string, end: string | null, sort: number) =>
  ({ id, tenant_id: "t1", event_id: "e1", kind, label: null, location: null, start_time: start,
    end_time: end, notes: null, sort_order: sort }) as ScheduleItem;

describe("EventSummary — run sheet · a long day (call > 12 h before the stage)", () => {
  it("prints the 06:00 call before the 18:30 stage", () => {
    render(
      <EventSummary event={event}
        schedule={[
          sched("a", "on_location", "06:00:00", null, 1),
          sched("b", "photo", "16:00:00", "16:30:00", 2),
          sched("c", "stage", "18:30:00", "19:00:00", 3),
          sched("d", "booth", "19:30:00", "21:00:00", 4),
        ]}
        setlist={[]} members={[]} showMic onNavigate={() => {}} tenantId="t1" />
    );
    const text = screen.getByText("Schedule").closest("section")!.textContent ?? "";
    const call = text.indexOf("06:00");
    const stage = text.indexOf("18:30–19:00");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(stage);
  });
});
