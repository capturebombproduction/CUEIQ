// The two sticky save bars on the event pages — the workspace's (บันทึก / อัปเดต) and
// the event form's (สร้างงาน / บันทึก). They float 8 px above the tab bar, which is
// right on a phone held upright and wrong on one held sideways:
//
//  CQ-43  at 844 x 390 the 52 px header + 60 px tab row + 58 px tab bar + this
//         ~60 px slab left ~150 px (131 with a notch) for the rows being edited. On
//         a short viewport the bar goes back into the flow, at the end of the page
//         (the workspace autosaves; the form's submit is the last thing in it).
//  CQ-48  app/globals.css keeps keyboard focus clear of whatever is stuck to the
//         edges; a bar that is there only sometimes needs a hook on it for that
//         rule — the marker class `has-action-bar`.
//
// Geometry cannot be proven in jsdom (no layout, no media queries). These pin the
// classes that carry it; the free band is measured in a real browser at 844 x 390.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/event/setlist-builder", () => ({ SetlistBuilder: () => null }));
vi.mock("@/components/event/schedule-editor", () => ({ ScheduleEditor: () => null }));
vi.mock("@/components/event/mic-map-editor", () => ({ MicMapEditor: () => null }));
vi.mock("@/components/event/lineup-editor", () => ({ LineupEditor: () => null }));

import { EventWorkspace } from "./event-workspace";
import { EventForm } from "./event-form";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const SHORT_STATIC = "[@media(max-height:500px)]:static";
const MARKER = "has-action-bar";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
const event = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "งานทดสอบ",
  event_date: "2026-12-01",
  event_type: "idol",
  status: "in_progress",
  is_template: false,
  group,
} as unknown as EventRow & { group: Group | null };

const classesOf = (el: HTMLElement | null) => (el?.className ?? "").split(/\s+/);

afterEach(() => {
  window.location.hash = "";
});

describe("the workspace's save bar", () => {
  const mount = () => {
    window.location.hash = "#setlist"; // an editor tab — the Summary has no save bar
    return render(
      <EventWorkspace
        event={event}
        eventId="e1"
        tenantId="t1"
        editable
        completeness={{ complete: false, missing: [] } as unknown as CompletenessResult}
        eventType="idol"
        showStartTime={null}
        hardOutTime={null}
        schedule={[]}
        setlist={[]}
        micMap={[]}
        members={[]}
        songs={[]}
        lineup={[]}
      />
    );
  };
  const bar = () => screen.getByRole("button", { name: /บันทึก \/ อัปเดต/ }).parentElement;

  it("goes back into the flow on a short viewport, and is still sticky otherwise", () => {
    mount();
    const cls = classesOf(bar());
    expect(cls).toContain("sticky");
    expect(cls).toContain(SHORT_STATIC);
  });

  it("carries the has-action-bar marker the scroll-padding rule looks for", () => {
    mount();
    expect(classesOf(bar())).toContain(MARKER);
  });
});

describe("the event form's save bar", () => {
  const mount = () =>
    render(
      <ConfirmProvider>
        <EventForm mode="create" tenantId="t1" groups={[group]} />
      </ConfirmProvider>
    );
  const bar = () => screen.getByRole("button", { name: "สร้างงาน" }).parentElement;

  it("goes back into the flow on a short viewport, and is still sticky otherwise", () => {
    mount();
    const cls = classesOf(bar());
    expect(cls).toContain("sticky");
    expect(cls).toContain(SHORT_STATIC);
  });

  it("carries the has-action-bar marker the scroll-padding rule looks for", () => {
    mount();
    expect(classesOf(bar())).toContain(MARKER);
  });
});
