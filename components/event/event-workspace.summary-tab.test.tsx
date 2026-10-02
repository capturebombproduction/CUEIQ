// Summary became the first segment of the tab row (spec G.3). It is a Radix
// TabsTrigger like its neighbours (so Tab and the arrow keys treat the row as one
// group, CQ-47) — but it takes over its own activation. Radix switches on MOUSEDOWN,
// and switching to Summary refreshes the page data so the run sheet and its JPG show
// what the editors just auto-saved (changeView → router.refresh). The editors save on
// BLUR, and a mousedown comes before the blur — so Radix's switch would read the
// database a moment before the last edit landed, and the exported sheet would miss
// it. So the Tabs ignore "summary" and the trigger switches on click (Enter and Space
// click too) or on focus arriving from a sibling tab.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group } from "@/lib/types";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
// The editors are code-split and talk to Supabase; this file is about the tab strip,
// not what is inside the tabs (a late chunk would crash on the stub client above).
vi.mock("@/components/event/setlist-builder", () => ({ SetlistBuilder: () => null }));
vi.mock("@/components/event/schedule-editor", () => ({ ScheduleEditor: () => null }));
vi.mock("@/components/event/mic-map-editor", () => ({ MicMapEditor: () => null }));
vi.mock("@/components/event/lineup-editor", () => ({ LineupEditor: () => null }));

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

describe("EventWorkspace · the Summary segment", () => {
  afterEach(() => {
    window.location.hash = "";
    router.refresh.mockClear();
  });

  it("refreshes for the run sheet on CLICK, after the field's blur — not on mousedown", () => {
    window.location.hash = "#setlist"; // an editor tab is open
    mount();
    const summary = screen.getByRole("tab", { name: "Summary" });
    expect(summary.getAttribute("data-state")).toBe("inactive");

    fireEvent.mouseDown(summary);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(summary.getAttribute("data-state")).toBe("inactive");

    fireEvent.click(summary);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(summary.getAttribute("data-state")).toBe("active");
  });

  it("already on Summary, pressing it again does not refetch", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  // The row sticks under the app header — and offline that header grows by the
  // in-flow offline strip (components/offline-banner.tsx publishes its height). With
  // --header-h alone the strip's height of the row slid under the glass: most of each
  // segment label hidden, at the venue, exactly when the app is offline.
  it("sticks below the whole header, the offline strip included", () => {
    mount();
    const bar = screen.getByRole("tab", { name: "Summary" }).closest(".lit-bar")!;
    const cls = bar.className.split(/\s+/);
    expect(cls).toContain("sticky");
    expect(cls).toContain("top-[calc(var(--header-h)+var(--offline-strip-h,0px)+env(safe-area-inset-top))]");
  });

  // CQ-43. A phone on its side is ~390 px tall: the 52 px header, this 60 px row and
  // the 58 px tab bar left ~150 px for the rows being edited. On a short viewport the
  // row gives back 8 px (the save bar's half is in save-bars.test.tsx). The geometry
  // itself can only be measured in a real browser — this pins that the rule exists.
  it("tightens its padding on a short viewport (a phone on its side)", () => {
    mount();
    const bar = screen.getByRole("tab", { name: "Summary" }).closest(".lit-bar")!;
    expect(bar.className.split(/\s+/)).toContain("[@media(max-height:500px)]:py-1");
  });
});

// CQ-47 (WCAG 3.2.1 On Focus). Summary used to be a plain button OUTSIDE Radix's
// roving-focus group, so when Tab entered the strip focus went to the first item the
// group knew — Setlist — and Radix's automatic activation switched the page to it.
// Now it is a TabsTrigger like the rest: the strip is entered at the SELECTED tab,
// and the arrow keys walk the whole row. What stays special is HOW it activates (see
// the first describe): only a click, never Radix's mousedown or focus.
describe("EventWorkspace · keyboard into and along the tab strip", () => {
  afterEach(() => {
    window.location.hash = "";
    router.refresh.mockClear();
  });
  const selected = (name: string) =>
    screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

  it("Tab into the strip while on Summary lands on Summary and does not switch to Setlist", async () => {
    const user = userEvent.setup();
    mount();
    expect(selected("Summary")).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Summary" }));
    expect(selected("Summary")).toBe(true);
    expect(selected("Setlist")).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("Tab into the strip on an editor tab lands on that tab and leaves the view alone", async () => {
    window.location.hash = "#schedule";
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(selected("Schedule")).toBe(true));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Schedule" }));
    expect(selected("Schedule")).toBe(true);
  });

  it("the arrow keys walk the whole row, Summary included, and Summary refreshes once on entry", async () => {
    const user = userEvent.setup();
    mount();
    await user.tab(); // on Summary
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(selected("Setlist")).toBe(true));
    expect(router.refresh).not.toHaveBeenCalled(); // leaving Summary reads nothing

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(selected("Summary")).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Summary" }));
    expect(router.refresh).toHaveBeenCalledTimes(1); // entering it does, as a click would
  });

  // The reason Summary is not simply left to Radix: its trigger switches on
  // MOUSEDOWN (and on focus), before the field being edited loses focus and starts
  // its autosave, and entering Summary refreshes the page data for the run sheet.
  // A real press focuses the button too, so this is the whole press, not just the
  // mousedown event.
  it("a press on Summary does not refresh until the click, even though it takes focus", async () => {
    window.location.hash = "#setlist";
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(selected("Setlist")).toBe(true));
    const summary = screen.getByRole("tab", { name: "Summary" });

    await user.pointer({ keys: "[MouseLeft>]", target: summary });
    expect(document.activeElement).toBe(summary);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(selected("Summary")).toBe(false);

    await user.pointer({ keys: "[/MouseLeft]" });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(selected("Summary")).toBe(true);
  });

  // The same press, but focus was on a SIBLING tab (clicking Setlist focuses it in
  // Chrome): that focus move comes from a tab, which is exactly what the arrow keys
  // look like, so only the press flag keeps it from switching before the click.
  it("a press on Summary from a focused sibling tab still waits for the click", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: "Setlist" }));
    await waitFor(() => expect(selected("Setlist")).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Setlist" }));
    const summary = screen.getByRole("tab", { name: "Summary" });

    await user.pointer({ keys: "[MouseLeft>]", target: summary });
    expect(document.activeElement).toBe(summary);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(selected("Summary")).toBe(false);

    await user.pointer({ keys: "[/MouseLeft]" });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(selected("Summary")).toBe(true);
  });

  // Where a button takes no focus on a press (Safari) there is no blur to clear the
  // press flag, so a press dragged off Summary — no click, ever — must clear it
  // another way, or the next arrow-key move onto Summary would move focus there
  // without selecting it.
  it("a press dragged off Summary does not leave the arrow keys unable to select it", async () => {
    window.location.hash = "#schedule";
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(selected("Schedule")).toBe(true));
    await user.tab(); // focus enters the strip on Schedule
    const summary = screen.getByRole("tab", { name: "Summary" });

    fireEvent.mouseDown(summary); // a press that takes no focus…
    fireEvent.mouseLeave(summary); // …dragged away, released elsewhere
    expect(router.refresh).not.toHaveBeenCalled();

    await user.keyboard("{Home}"); // Summary is the first tab
    await waitFor(() => expect(selected("Summary")).toBe(true));
    expect(document.activeElement).toBe(summary);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

// Spec G.3 puts the approvers' copyright triage IN the Summary. It used to sit
// between the hero and these tabs — one 62 px row per song, ~800 px for twelve —
// so the tabs fell off a phone's first screen. Under the run sheet it must still
// keep what was done in it: the Summary remounts on every return, and a panel
// re-seeded from page-load props would show a song just approved as waiting.
describe("EventWorkspace · what sits under the Summary", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  function Counter() {
    const [n, setN] = useState(0);
    return (
      <button type="button" onClick={() => setN((v) => v + 1)}>
        นับ {n}
      </button>
    );
  }
  const mountWithFooter = () =>
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
        summaryFooter={<Counter />}
      />
    );

  it("comes after the tab row, shows on Summary only, and keeps its state across a tab trip", () => {
    mountWithFooter();
    const footer = screen.getByRole("button", { name: /นับ/ });
    const tablist = screen.getByRole("tablist");
    // after the tabs in document order — the tabs are not pushed down by it
    expect(tablist.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(footer);
    expect(footer.textContent).toBe("นับ 1");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Setlist" }));
    expect(footer.closest("[hidden]")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const back = screen.getByRole("button", { name: /นับ/ });
    expect(back.closest("[hidden]")).toBeNull();
    expect(back.textContent).toBe("นับ 1");
  });
});
