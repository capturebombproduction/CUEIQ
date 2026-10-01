// The Setlist tab as the redesign draws it (spec G.3). A member reads the set —
// they cannot edit it — so their rows are a compact cue list (kind tile, title,
// start, mics, length) instead of the editor's disabled inputs. And a set that runs
// past the hard out says so in the band-independent alarm, never in --destructive:
// lib/skin.ts moves that token off red for a red band, so Seishin Kakumei's
// overtime read violet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeSession, makeSupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem } from "@/lib/types";

const row = (id: string, sort: number, title: string, kind: SetlistItem["kind"], dur: number): SetlistItem => ({
  id,
  event_id: "e1",
  tenant_id: "t1",
  kind,
  title,
  sort_order: sort,
  duration_seconds: dur,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: id === "s1" ? [{ mic: "1", member: "Aya" }] : [],
  notes: null,
});

// 13:00 start, 13:05 hard out: the song ends 13:04, the MC runs to 13:08 — over.
const items = [row("s1", 1, "Kakumei", "song", 240), row("mc", 2, "MC ปิด", "mc", 240)];

beforeEach(() => {
  h.supa = makeSupabaseFake({ session: makeSession() });
});

const mount = (editable: boolean) =>
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId="e1"
        tenantId="t1"
        editable={editable}
        initialItems={items}
        showStartTime="13:00:00"
        hardOutTime="13:05:00"
        members={[]}
        songs={[]}
        eventName="Test show"
      />
    </ConfirmProvider>
  );

describe("SetlistBuilder — a member's cue list", () => {
  it("is rows to read, not disabled fields: kind, title, start, mics, length", () => {
    mount(false);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "SONG" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "MC" })).toBeInTheDocument();
    expect(screen.getByText("Kakumei")).toBeInTheDocument();
    expect(screen.getByText("1·Aya")).toBeInTheDocument();
    expect(screen.getByText("13:04")).toBeInTheDocument(); // the MC's planned start
  });
});

// The row's kind select, by its classes (jsdom has no layout). Tailwind spacing is
// n × 4 px; pl / pr are emitted after px, so they win where both are present.
const spacing = (cls: string, prefix: string): number | null => {
  const m = cls.split(/\s+/).find((c) => c.startsWith(`${prefix}-`))?.slice(prefix.length + 1);
  if (m == null) return null;
  const arb = m.match(/^\[(\d+(?:\.\d+)?)px\]$/);
  return arb ? Number(arb[1]) : Number(m) * 4;
};

describe("SetlistBuilder — an editor row's kind select", () => {
  // Measured in Chrome, Kanit 400: "GUEST" is 46.9 px at the phone's 16 px (41.0 at
  // 14 px), "SONG" 41.0. In the old 88 px wrapper the field's px-3.5 + gap-2 + 16 px
  // chevron left 36 px: every SONG row read "SONC" on a phone.
  it("leaves the label room for GUEST at 16 px, and keeps the row one line at 390", () => {
    mount(true);
    const triggers = screen.getAllByRole("combobox");
    expect(triggers.length).toBe(items.length);
    for (const trigger of triggers) {
      const cls = trigger.className;
      const width = spacing(trigger.parentElement!.className, "w")!;
      const px = spacing(cls, "px") ?? 0;
      const left = spacing(cls, "pl") ?? px;
      const right = spacing(cls, "pr") ?? px;
      const gap = spacing(cls, "gap") ?? 0;
      const chevron = spacing(trigger.querySelector("svg")!.getAttribute("class")!, "w")!;
      expect(width - left - right - gap - chevron).toBeGreaterThanOrEqual(50);

      // A 390 px phone gives the row 334 px (16 px gutters, the slab's p-3). With a
      // mouse the drag grip shows too, and grip · index · select · the row's icon
      // buttons must share line one, or the buttons drop to a line of their own.
      const row = trigger.closest(".flex-wrap")!;
      const grip = spacing(row.querySelector("[draggable]")!.className, "w")!;
      const index = spacing(row.querySelector("span.num")!.className, "w")!;
      const buttons = [...row.querySelectorAll(":scope > .order-1 > button")].reduce(
        (sum, b) => sum + spacing(b.className, "w")!,
        0
      );
      expect(buttons).toBe(4 * 44);
      expect(grip + index + width + buttons + 3 * spacing(row.className, "gap")!).toBeLessThanOrEqual(334);
    }
  });
});

describe("SetlistBuilder — past the hard out", () => {
  it.each([false, true])("is the alarm with its word (editable: %s), never --destructive", (editable) => {
    const { container } = mount(editable);
    const chip = screen.getByText(/เกิน Hard Out \+3:00/).closest(".chip")!;
    expect(chip.className.split(" ")).toContain("chip-alarm");
    // the late row carries the word too, not colour alone
    expect(screen.getAllByText("เกิน Hard Out").length).toBe(1);
    // (a delete button's own red and a field's invalid ring are theirs, not the row's)
    expect(
      container.querySelector('[class*="destructive"]:not(button):not(input), .chip-danger')
    ).toBeNull();
  });
});
