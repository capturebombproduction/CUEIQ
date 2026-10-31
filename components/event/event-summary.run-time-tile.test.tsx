// The sheet's four tiles: the run time beside three clock times. Seishin's Ar reported
// (feedback 2026-10-31, on the summary and its JPG) that "20:00" next to "13:40" and
// "14:00" reads as eight in the evening when it means a 20-minute set. The tile states
// its unit, so a length can't pass for a time of day.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventRow, Group, SetlistItem } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { EventSummary } from "@/components/event/event-summary";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
const event = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-31",
  venue: null, event_type: "idol", show_start_time: "13:40:00", hard_out_time: "14:00:00", status: "draft",
  notes: null, map_url: null, costume_theme: null, is_template: false, group,
} as unknown as EventRow & { group: Group | null };
const song = (sec: number) =>
  ({ id: "s1", tenant_id: "t1", event_id: "e1", kind: "song", title: "เพลง 1", duration_seconds: sec,
    buffer_before_seconds: 0, buffer_after_seconds: 0, mic_slots: [], notes: null, sort_order: 1 }) as SetlistItem;

const runTimeTile = (seconds: number) => {
  render(
    <EventSummary event={event} schedule={[]} setlist={[song(seconds)]} members={[]} showMic
      onNavigate={() => {}} tenantId="t1" />
  );
  return screen.getByText("Run time").parentElement!.textContent;
};

describe("summary sheet · the Run time tile", () => {
  it("says a whole-minute set in minutes, not as a clock-shaped 20:00", () => {
    expect(runTimeTile(1200)).toBe("Run time20 นาที");
  });

  it("keeps the seconds of a set that isn't a whole minute, with the unit", () => {
    expect(runTimeTile(1187)).toBe("Run time19:47 นาที");
  });

  it("says hours for a oneman's long set", () => {
    expect(runTimeTile(3930)).toBe("Run time1:05:30 ชม.");
  });

  it("leaves the three clock tiles beside it alone", () => {
    runTimeTile(1200);
    const tiles = screen.getByText("Run time").parentElement!.parentElement!.children;
    expect(Array.from(tiles).slice(0, 3).map((tile) => tile.textContent)).toEqual([
      "นัด—",
      "ขึ้นเวที13:40",
      "Hard Out14:00",
    ]);
  });
});
