// SET MIXER keeps the row after NOW - AUTO's 5 4 3 2 1 and GO's tag - in view as NOW moves along a
// setlist wider than the panel (spec B puts the count "on the next pad in SET MIXER").
// Found by the 2026-10-25 bug hunt (six reviewers, each finding proven by a test that failed on
// a003fe0), kept as the regression suite for what it found. Harness as components/event/live-mode.test.tsx.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { SetMixer } from "@/components/live/set-mixer";
import type { ConsoleItem } from "@/components/live/console-board";

const TILE = 52;
const GAP = 3;
const VIEW = 550; // ten tiles' worth of panel

const item = (n: number): ConsoleItem => ({
  id: `item-${n}`,
  kind: "song",
  title: `Track ${n}`,
  block: 240,
  audioStart: 0,
  audioLen: 240,
  loop: false,
  notes: null,
  songId: null,
  lufs: -12,
  peaks: null,
  bpm: null,
  beatOffset: null,
  mics: [],
});
const ITEMS = Array.from({ length: 20 }, (_, i) => item(i + 1));

const saved: Array<[string, PropertyDescriptor | undefined]> = [];
function stub(key: string, d: PropertyDescriptor) {
  saved.push([key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]);
  Object.defineProperty(HTMLElement.prototype, key, { configurable: true, ...d });
}
afterEach(() => {
  for (const [k, d] of saved.reverse()) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  saved.length = 0;
});

describe("SetMixer · keeps the NEXT tile (the count, GO) in view", () => {
  it("AUTO, NOW moves from tile 10 to tile 11 of 20: the next tile with the count is on screen", () => {
    const scroll = new WeakMap<HTMLElement, number>();
    const strip = (el: HTMLElement) => el.getAttribute("data-testid") === "console-strip";
    stub("offsetLeft", {
      get(this: HTMLElement) {
        return strip(this) ? Array.prototype.indexOf.call(this.parentElement!.children, this) * (TILE + GAP) : 0;
      },
    });
    stub("offsetWidth", { get(this: HTMLElement) { return strip(this) ? TILE : 0; } });
    stub("clientWidth", { get(this: HTMLElement) { return this.className.includes("overflow-x-auto") ? VIEW : 0; } });
    stub("scrollLeft", {
      get(this: HTMLElement) { return scroll.get(this) ?? 0; },
      set(this: HTMLElement, v: number) { scroll.set(this, v); },
    });
    const liveRef = createRef<HTMLSpanElement>();
    const { rerender } = render(<SetMixer items={ITEMS} index={9} playingId={null} liveRef={liveRef} count={null} />);
    rerender(<SetMixer items={ITEMS} index={10} playingId={null} liveRef={liveRef} count={3} />);
    const strips = screen.getAllByTestId("console-strip");
    const row = strips[0].parentElement as HTMLElement;
    const next = strips[11];
    expect(next.querySelector('[data-testid="console-strip-count"]')).not.toBeNull();
    const left = next.offsetLeft;
    const right = left + next.offsetWidth;
    // NOW (tile 11) is in view...
    expect(strips[10].offsetLeft + TILE).toBeLessThanOrEqual(row.scrollLeft + VIEW);
    // Before the 2026-10-25 fix: scrollLeft = 56, view = [56, 606]; the next tile is at 605..657
    expect(right).toBeLessThanOrEqual(row.scrollLeft + VIEW);
  });
});
