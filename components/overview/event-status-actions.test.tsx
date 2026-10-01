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
