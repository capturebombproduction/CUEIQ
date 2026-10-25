// SET MIXER (components/live/set-mixer.tsx) on its own: a tile fader moves only by a drag, a
// read-only one leaves the touch to the scroll, Enter with GO off is nobody's click.
// Found by the 2026-10-25 bug hunt (six reviewers, each finding proven by a test that failed on
// a003fe0), kept as the regression suite for what it found. Harness as components/event/live-mode.test.tsx.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { SetMixer, type PadsView } from "@/components/live/set-mixer";
import type { ConsoleItem } from "@/components/live/console-board";

function item(n: number, over: Partial<ConsoleItem> = {}): ConsoleItem {
  return {
    id: `item-${n}`,
    kind: "song",
    title: `Track ${n}`,
    block: 200,
    audioStart: 0,
    audioLen: 200,
    loop: false,
    notes: null,
    songId: `song-${n}`,
    lufs: -14,
    peaks: null,
    bpm: null,
    beatOffset: null,
    mics: [],
    ...over,
  };
}
const ITEMS = [item(1), item(2), item(3)];

function pads(over: Partial<PadsView> = {}): PadsView {
  return {
    mode: "manual",
    sounding: { "item-1": { elapsed: 30, total: 200, fadeAt: null, level: null } },
    played: new Set(["item-1"]),
    levels: { "item-1": 100, "item-2": 100, "item-3": 100 },
    now: Date.now(),
    onPad: vi.fn(),
    onGo: vi.fn(),
    onLevel: vi.fn(),
    ...over,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("SetMixer · a tile fader", () => {
  it("a press on the cap never moves the level (a 19 px rail at 1024x768, 11 px of travel)", async () => {
    const p = pads();
    render(<SetMixer items={ITEMS} index={0} playingId="item-1" liveRef={createRef()} pads={p} />);
    const fader = screen.getAllByTestId("console-tile-fader")[0];
    // the rail as Chromium lays it out at 1024x768 (measured: SET MIXER root 124 px → fader row 19 px)
    vi.spyOn(fader, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 119, height: 19, left: 0, right: 18, width: 18, x: 0, y: 100, toJSON() {} } as DOMRect);
    // value 100: the cap is drawn at top 0..8 px of the rail (its middle at 104). The operator grabs the cap at 107.
    fireEvent.pointerDown(fader, { clientY: 107, pointerId: 1 });
    // grabbing a fader's cap is not a move
    expect(p.onLevel).not.toHaveBeenCalled();
  });

  it("a drag moves the level from where it stood, by how far the finger went - past a 3 px dead zone", () => {
    const p = pads({ levels: { "item-1": 60, "item-2": 100, "item-3": 100 } });
    render(<SetMixer items={ITEMS} index={0} playingId="item-1" liveRef={createRef()} pads={p} />);
    const fader = screen.getAllByTestId("console-tile-fader")[0];
    // a 48 px rail: 40 px of travel for 0-100
    vi.spyOn(fader, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 148, height: 48, left: 0, right: 18, width: 18, x: 0, y: 100, toJSON() {} } as DOMRect);
    vi.spyOn(fader, "hasPointerCapture").mockReturnValue(true);
    // pressed low on the rail, far from the cap: nothing moves
    fireEvent.pointerDown(fader, { clientY: 140, pointerId: 1 });
    expect(p.onLevel).not.toHaveBeenCalled();
    // a 2 px wobble is still a press
    fireEvent.pointerMove(fader, { clientY: 142, pointerId: 1 });
    expect(p.onLevel).not.toHaveBeenCalled();
    // 10 px down = a quarter of the travel: 60 → 35
    fireEvent.pointerMove(fader, { clientY: 150, pointerId: 1 });
    expect(p.onLevel).toHaveBeenLastCalledWith("item-1", 35);
    fireEvent.pointerUp(fader, { clientY: 150, pointerId: 1 });
  });

  it("a read-only fader (AUTO) leaves the touch to the tiles' scroll (no touch-action:none)", () => {
    render(<SetMixer items={ITEMS} index={0} playingId="item-1" liveRef={createRef()} pads={pads({ mode: "auto", onPad: null, onGo: null, onLevel: null })} />);
    const fader = screen.getAllByTestId("console-tile-fader")[0];
    expect(fader).toHaveAttribute("aria-disabled", "true");
    expect(fader.className).not.toContain("touch-none");
  });
});

describe("SetMixer · Enter with GO disabled (NOW = the last row)", () => {
  it("Enter on a focused pad is taken: the browser's own Enter activation never clicks it", () => {
    const p = pads({ sounding: { "item-3": { elapsed: 30, total: 200, fadeAt: null, level: null } } });
    render(<SetMixer items={ITEMS} index={2} playingId="item-3" liveRef={createRef()} pads={p} />);
    expect(screen.getByTestId("console-go")).toBeDisabled();
    const pad3 = screen.getAllByTestId("console-pad")[2];
    pad3.focus();
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    pad3.dispatchEvent(ev);
    // Chromium: Enter on a focused <button> clicks it unless keydown was default-prevented
    if (!ev.defaultPrevented) pad3.click();
    expect(p.onPad).not.toHaveBeenCalled();
  });
});
