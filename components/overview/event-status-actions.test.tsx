// The status dialog says what the show's status is now. It used to read
// "สถานะตอนนี้คือ 🟠 Pending Review"; it is the status icon + the word now.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GroupStatus } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: () => b,
        eq: () => b,
        select: () => Promise.resolve({ data: [{ id: "e1" }], error: null }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventStatusActions } from "./event-status-actions";

const EMOJI = /\p{Extended_Pictographic}|️/u;

function openDescription(status: GroupStatus) {
  render(<EventStatusActions eventId="e1" eventName="Sourgrumy" initialStatus={status} />);
  fireEvent.click(screen.getByTitle(/แตะเพื่อเปลี่ยนสถานะ/));
  const dialog = screen.getByRole("dialog");
  return document.getElementById(dialog.getAttribute("aria-describedby")!)!;
}

describe("EventStatusActions dialog", () => {
  it("names the current status with its icon and word, no emoji", () => {
    const desc = openDescription("pending_review");
    expect(desc.textContent).toContain("Pending Review");
    expect(desc.textContent).not.toMatch(EMOJI);
    const icon = desc.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
  });

  // The chip already falls back to Draft for a status the app does not know; the
  // dialog it opens must not be the thing that crashes on it.
  it("opens on a status the app does not know, describing it as the chip does", () => {
    const desc = openDescription("archived" as GroupStatus);
    expect(desc.textContent).toContain("Draft");
    expect(desc.querySelector("svg")).not.toBeNull();
  });
});

// CQ-36 — the status chip is a ~24 px control from `sm` (the board turns into a dense
// table there), and a touch iPad is `sm`. It keeps its look; an invisible ::after grows
// the TAP area to ~44 px, the same trick the chips beside it use (HIT_44). jsdom has no
// layout, so this pins the class contract — the 768-wide touch measurement is the harness's.
describe("EventStatusActions trigger (CQ-36)", () => {
  it("keeps a 44 px phone box and grows a ~44 px hit area from `sm`, where the chip shrinks", () => {
    render(<EventStatusActions eventId="e1" initialStatus="pending_review" />);
    const tokens = screen.getByTitle(/แตะเพื่อเปลี่ยนสถานะ/).className.split(/\s+/);
    // The chip's own look is unchanged…
    expect(tokens).toContain("min-h-11");
    expect(tokens).toContain("sm:min-h-0");
    // …and the pseudo-element sits above and below it, full width, like HIT_44.
    expect(tokens).toContain("relative");
    expect(tokens).toContain("sm:after:absolute");
    expect(tokens).toContain("sm:after:-inset-y-2.5");
    expect(tokens).toContain("sm:after:inset-x-0");
    expect(tokens).toContain("sm:after:content-['']");
  });
});
