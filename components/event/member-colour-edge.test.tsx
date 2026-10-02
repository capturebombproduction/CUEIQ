// CQ-60 (round 15). The Lineup tile ring and the Mic cap paint members.color verbatim
// as their only edge, so a pale colour on a light card (Highway #efefef, Cherrie
// #ffff00) or a near-black one on a dark card (Sunny #434343) drew no edge at all.
// Each now carries a neutral hairline (hsl(var(--border))) that does not depend on
// the member's colour. jsdom has no layout or theme, so what is pinned here is that
// the hairline is in the painted style whatever the colour — the look itself still
// wants a real-browser check on the real-data lineup shots.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Member } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { LineupEditor } from "@/components/event/lineup-editor";
import { MicTile } from "@/components/event/mic-grid";

const member = (n: number, color: string | null): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});

// The three colours the audit named, plus a saturated one and a member with none.
const COLOURS: [string, string][] = [
  ["pale grey", "#efefef"],
  ["pure yellow", "#ffff00"],
  ["near black", "#434343"],
  ["saturated red", "#A62A1C"],
];

describe("LineupEditor · the colour ring has an edge of its own", () => {
  it.each(COLOURS)("%s: a hairline in --border sits outside the member's colour", (_n, color) => {
    render(
      <ConfirmProvider>
        <LineupEditor
          eventId="e1"
          tenantId="t1"
          editable={false}
          members={[member(1, color)]}
          initialLineup={["m1"]}
        />
      </ConfirmProvider>
    );
    const tile = screen.getByText("1", { selector: "span.num" });
    const shadow = tile.style.boxShadow;
    // member colour is still the ring (the look is unchanged)…
    expect(shadow.toLowerCase()).toContain(`0 0 0 4px ${color.toLowerCase()}`);
    // …and the outermost layer is the neutral hairline, 1px beyond it
    expect(shadow).toContain("var(--border)");
    expect(shadow.endsWith(", 0 0 0 5px hsl(var(--border))")).toBe(true);
  });

  it("a member with no colour keeps the plain border-coloured ring (no doubled edge)", () => {
    render(
      <ConfirmProvider>
        <LineupEditor
          eventId="e1"
          tenantId="t1"
          editable={false}
          members={[member(1, null)]}
          initialLineup={["m1"]}
        />
      </ConfirmProvider>
    );
    const shadow = screen.getByText("1", { selector: "span.num" }).style.boxShadow;
    expect(shadow.endsWith("0 0 0 4px hsl(var(--border))")).toBe(true);
    expect(shadow).not.toContain("5px");
  });
});

describe("MicTile · the colour cap has an edge of its own", () => {
  it.each(COLOURS)("%s: the cap carries an inset --border hairline", (_n, color) => {
    const { container } = render(<MicTile mic={3} name="นิค3" color={color} />);
    const cap = container.querySelector(".mic > i") as HTMLElement;
    expect(cap).not.toBeNull();
    expect(cap.style.boxShadow).toContain("inset");
    expect(cap.style.boxShadow).toContain("var(--border)");
    // the member's colour is still what fills it
    expect(cap.style.background).not.toBe("");
  });

  it("draws no cap at all for a member with no colour", () => {
    const { container } = render(<MicTile mic={3} name="นิค3" color={null} />);
    expect(container.querySelector(".mic > i")).toBeNull();
  });
});
