// Summary became the first segment of the tab row (spec G.3). It is deliberately
// NOT a Radix TabsTrigger: a trigger switches on MOUSEDOWN, and switching to
// Summary refreshes the page data so the run sheet and its JPG show what the
// editors just auto-saved (changeView → router.refresh). The editors save on BLUR,
// and a mousedown comes before the blur — so a trigger would read the database a
// moment before the last edit landed, and the exported sheet would miss it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
