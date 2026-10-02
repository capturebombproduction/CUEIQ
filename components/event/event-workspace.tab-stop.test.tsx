// CQ-47 follow-up (WCAG 3.2.1 On Focus). Summary is a Radix TabsTrigger, and Radix gives
// tabIndex 0 to the LAST-FOCUSED trigger of the strip — not to the selected one. So once
// Summary has been the roving tab stop, Shift+Tab from a field in an editor lands on
// Summary again while the page is on another tab. Summary used to switch itself on ANY
// focus; here that moved the page from Setlist back to Summary (and refreshed it) just
// because a keyboard user walked back up the page. It may activate on focus only when
// focus arrives from a SIBLING tab (arrow keys, Home/End) — never from a field.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group } from "@/lib/types";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
// A field to be inside of, and a way off the Summary that does not touch the strip
// (the real Summary's "ไปแก้ไข" buttons, which need an editable page and its Supabase
// calls — this file is about where focus goes, not about what the tabs hold).
vi.mock("@/components/event/setlist-builder", () => ({
  SetlistBuilder: () => <input aria-label="ช่องในเซ็ตลิสต์" />,
}));
vi.mock("@/components/event/schedule-editor", () => ({ ScheduleEditor: () => null }));
vi.mock("@/components/event/mic-map-editor", () => ({ MicMapEditor: () => null }));
vi.mock("@/components/event/lineup-editor", () => ({ LineupEditor: () => null }));
vi.mock("@/components/event/event-summary", () => ({
  EventSummary: ({ onNavigate }: { onNavigate: (v: string) => void }) => (
    <button type="button" onClick={() => onNavigate("setlist")}>
      ไปแก้ไข Setlist
    </button>
  ),
}));

import { EventWorkspace } from "./event-workspace";

const event = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "งานทดสอบ",
  event_date: "2026-12-01",
  event_type: "idol",
  status: "in_progress",
  is_template: false,
  group: { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group,
} as unknown as EventRow & { group: Group | null };

const mount = () =>
  render(
    <EventWorkspace
      event={event}
      eventId="e1"
      tenantId="t1"
      editable={false}
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

describe("EventWorkspace · Shift+Tab back up into the tab strip", () => {
  afterEach(() => {
    window.location.hash = "";
    router.refresh.mockClear();
  });
  const selected = (name: string) =>
    screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

  it("landing on a stale Summary tab stop from an editor field does not switch the page", async () => {
    const user = userEvent.setup();
    mount();
    // Summary becomes the strip's tab stop (Tab enters at the selected tab)…
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Summary" }));
    // …then the page moves on to Setlist without the strip being touched.
    await user.click(screen.getByRole("button", { name: "ไปแก้ไข Setlist" }));
    await waitFor(() => expect(selected("Setlist")).toBe(true));
    const field = await screen.findByRole("textbox", { name: "ช่องในเซ็ตลิสต์" });
    await user.click(field);
    expect(document.activeElement).toBe(field);
    router.refresh.mockClear();

    // Shift+Tab out of the field: panel, then the strip — onto the stale tab stop.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Summary" }));

    // Focus moved; the page did not (WCAG 3.2.1), and nothing was refetched.
    expect(selected("Setlist")).toBe(true);
    expect(selected("Summary")).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("Enter on Summary there still switches to it, refreshing once", async () => {
    const user = userEvent.setup();
    mount();
    await user.tab();
    await user.click(screen.getByRole("button", { name: "ไปแก้ไข Setlist" }));
    await waitFor(() => expect(selected("Setlist")).toBe(true));
    const field = await screen.findByRole("textbox", { name: "ช่องในเซ็ตลิสต์" });
    await user.click(field);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Summary" }));
    expect(router.refresh).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(selected("Summary")).toBe(true);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
