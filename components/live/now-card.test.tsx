// Live Mode's NOW card (FINAL-SPEC-v2 §G.10). Heights are a browser's business, but
// what decides "one height in every zone" is visible here: the SAME rows in the same
// order whatever the zone — a header strip, the title row, a fixed note line even
// when there is no note, a countdown with its fixed box, a meter, the labels. A zone
// that added or dropped a row would let the NEXT card's mic grid slide under the dock.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NowCard } from "./now-card";
import type { LiveZone } from "@/lib/live-zone";

// A 1:32 SE: WARN at <= 0:46, URGENT at <= 0:23 (lib/live-zone thresholds).
const BLOCK = 92;
const REMAINING: Record<LiveZone, number> = { ok: 60, warn: 40, urgent: 20, over: -4 };

function card(zone: LiveZone, over: Partial<React.ComponentProps<typeof NowCard>> = {}) {
  const { container, unmount } = render(
    <NowCard
      zone={zone}
      blockSec={BLOCK}
      remaining={REMAINING[zone]}
      elapsed={BLOCK - REMAINING[zone]}
      index={2}
      total={16}
      kind="se"
      title="Opening SE"
      note={null}
      endClock="18:05:25"
      canAdvance
      {...over}
    >
      <div data-testid="fade-row" />
    </NowCard>
  );
  return { el: container.querySelector("section[data-zone]") as HTMLElement, unmount };
}

/** The card's rows, as a shape: what each direct child IS, not what it says. */
function shape(el: HTMLElement) {
  return Array.from(el.children).map((c) => {
    if (c.classList.contains("zhead")) return "header";
    if (c.querySelector("h2")) return "title";
    if (c.classList.contains("h-5")) return "note";
    if (c.querySelector(".cd-wrap")) return "countdown";
    if (c.classList.contains("track") || c.classList.contains("hatch")) return "meter";
    if (c.querySelector('[data-testid="fade-row"]')) return "children";
    return "labels";
  });
}

describe("NowCard · one shape, four zones", () => {
  it("has the same rows in the same order in ok / warn / urgent / over", () => {
    const shapes = (["ok", "warn", "urgent", "over"] as const).map((z) => {
      const { el, unmount } = card(z);
      const s = shape(el);
      // the countdown keeps the SAME fixed box whatever it shows ("1:00", "+0:04")
      expect(el.querySelector<HTMLElement>(".cd-wrap")!.style.height, z).toBe("131px");
      unmount();
      return s;
    });
    expect(shapes[0]).toEqual(["header", "title", "note", "countdown", "meter", "labels", "children"]);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it("each step is its own shape: the frame, the fill, the inversion — never the band", () => {
    expect(card("ok").el).toHaveClass("lit", "cut");
    expect(card("warn").el).toHaveClass("lit", "zone-warn");
    const urgent = card("urgent").el;
    expect(urgent).toHaveClass("lit", "zone-urgent");
    expect(urgent).not.toHaveClass("alarm-plate"); // URGENT is never the light plate
    const over = card("over").el;
    expect(over).toHaveClass("alarm-plate");
    // square (no chamfer), and loud until it has been seen for ten seconds
    for (const cls of ["lit", "cut", "settled"]) expect(over).not.toHaveClass(cls);
  });

  it("names the threshold it crossed, in the item's own scaled numbers", () => {
    expect(within(card("warn").el).getByText("Warn")).toBeTruthy();
    expect(screen.getByText("≤0:46")).toBeTruthy();
    expect(within(card("urgent").el).getByText("Urgent")).toBeTruthy();
    expect(screen.getByText("≤0:23")).toBeTruthy();
  });
});

describe("NowCard · overtime", () => {
  it("announces once under a hazard band, counts up with a +, and settles ten seconds past zero", () => {
    const { el, unmount } = card("over", { remaining: -4 });
    expect(within(el).getByRole("alert")).toHaveTextContent("Overtime · เกินเวลา");
    expect(within(el).getByRole("alert")).toHaveClass("hazard-band");
    expect(within(el).getByRole("timer")).toHaveTextContent("+0:04");
    expect(el).not.toHaveClass("settled");
    unmount();

    expect(card("over", { remaining: -10 }).el).toHaveClass("alarm-plate", "settled");
  });

  it("tells THIS device to press NEXT only when it can", () => {
    const { el, unmount } = card("over");
    expect(el).toHaveTextContent("กด NEXT เมื่อพร้อม");
    unmount();
    const locked = card("over", { canAdvance: false }).el;
    expect(locked).not.toHaveTextContent("กด NEXT");
    expect(locked).toHaveTextContent("วางไว้ 1:32");
  });

  it("no ALERT outside overtime — the ladder's other steps do not interrupt a screen reader", () => {
    for (const z of ["ok", "warn", "urgent"] as const) {
      const { el, unmount } = card(z);
      expect(within(el).queryByRole("alert"), z).toBeNull();
      unmount();
    }
  });
});

describe("NowCard · offline cached rows", () => {
  it("a row that lost its kind shows no chip instead of crashing", () => {
    const { el } = card("ok", { kind: null });
    expect(el.querySelector(".chip")).toBeNull();
    expect(within(el).getByRole("heading", { level: 2 })).toHaveTextContent("Opening SE");
  });

  it("the cue note sits on its one fixed line", () => {
    const { el } = card("ok", { note: "เปิดไฟแดงเต็มเวที" });
    const note = within(el).getByText("เปิดไฟแดงเต็มเวที");
    expect(note.closest(".h-5")).not.toBeNull();
  });
});
