// The ⋯ sheet's width must come from the viewport, never from its own header text.
//
// DialogContent is a `grid` with one implicit auto column, and its DialogHeader is a
// grid item with min-width:auto. The header holds a `truncate` (white-space:nowrap)
// description carrying the event name, so a long name (Seishin's festival title) made
// the header's min-content ~479 px; that widened the only track to 519 px at a 390 px
// phone, the action rows followed, and the sheet scrolled sideways. `min-w-0` on the
// header lets the track shrink to the sheet and the description ellipsise instead.
//
// jsdom has no layout engine, so this cannot measure the width. It pins the one class
// that fixes the cause; the real-browser measurement (dialog scrollWidth ==
// clientWidth at 360/390/820/1280 with the long name) lives in the harness.
import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { EventMoreMenu } from "./event-more-menu";

const LONG_NAME =
  "SEISHIN KAKUMEI 精神革命 ONE-MAN LIVE: THE LONG NAME THAT USED TO WIDEN THE SHEET";

describe("EventMoreMenu · the header cannot widen the sheet", () => {
  it("the header (grid item holding the nowrap description) has min-w-0", async () => {
    render(
      <EventMoreMenu eventName={LONG_NAME}>
        <Button type="button">Export Excel</Button>
      </EventMoreMenu>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });

    const description = screen.getByText(new RegExp(LONG_NAME));
    // The nowrap description is what makes the header's min-content huge ...
    expect(description.className).toContain("truncate");
    // ... so its parent (the grid item) must be allowed to shrink below that.
    const header = description.parentElement as HTMLElement;
    expect(header).toBe(screen.getByRole("heading", { name: "More" }).parentElement);
    expect(header.className).toContain("min-w-0");
  });
});
