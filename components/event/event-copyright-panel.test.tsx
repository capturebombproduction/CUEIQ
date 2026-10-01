// The approver's rights triage on an event page. The rights chip used to lead with
// the map's emoji (✅ / 🕒 / ⛔); it is a StatusChip now — lucide icon + the Thai word.
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: () => b,
        eq: () => b,
        select: () => Promise.resolve({ data: [{ id: "s1" }], error: null }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventCopyrightPanel } from "./event-copyright-panel";

const EMOJI = /\p{Extended_Pictographic}|️/u;

describe("EventCopyrightPanel rights chips", () => {
  it("are icon + word, never an emoji", () => {
    const { container } = render(
      <EventCopyrightPanel
        songs={[
          { id: "s1", title: "Kakumei", copyright_status: "cleared" },
          { id: "s2", title: "Seishin", copyright_status: "pending" },
          { id: "s3", title: "Breach", copyright_status: "rejected" },
        ]}
      />
    );
    const chips = [...container.querySelectorAll<HTMLElement>(".chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["ถูกต้อง", "รอตรวจ", "ถูกปฏิเสธ"]);
    for (const chip of chips) {
      expect(chip.textContent).not.toMatch(EMOJI);
      const icon = chip.querySelector("svg");
      expect(icon, "a rights chip is never colour alone").not.toBeNull();
      expect(icon!.getAttribute("aria-hidden")).toBe("true");
    }
    // three statuses, three different glyphs
    expect(new Set(chips.map((c) => c.querySelector("svg")!.getAttribute("class"))).size).toBe(3);
  });
});
