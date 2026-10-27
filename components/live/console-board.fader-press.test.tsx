// components/live/console-board.tsx - CONSOLE's channel fader (the cued track's level). A press
// must never move it; only a drag does, from where the level stood. Until 2026-10-27 (hunt 7) a
// press set the level to the point under the finger: a tap 5 px under the cap's middle took the
// SOUNDING track from 100 to ~85 at once - the fix SET MIXER's tile fader got on 2026-10-25,
// never brought to this one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConsoleBoard, type ConsoleItem } from "./console-board";

const item = (n: number): ConsoleItem => ({
  id: `item-${n}`,
  kind: "song",
  title: `Track ${n}`,
  block: 240,
  audioStart: 0,
  audioLen: 240,
  loop: false,
  notes: null,
  songId: `song-${n}`,
  lufs: -14,
  peaks: null,
  bpm: null,
  beatOffset: null,
  mics: [],
});

type Props = React.ComponentProps<typeof ConsoleBoard>;
function mount(volume: number, onVolume: (v: number) => void) {
  const props: Props = {
    items: [item(1), item(2)],
    index: 0,
    elapsed: 30,
    remaining: 210,
    zone: "ok",
    running: true,
    endClock: "21:04:30",
    markers: {},
    playingId: "item-1",
    sounding: true,
    tap: null,
    player: () => null,
    volume,
    onVolume,
    onFade: vi.fn(),
    output: { label: "USB Audio CODEC", kind: "external" },
    soundOn: true,
    onOutput: vi.fn(),
    onCue: vi.fn(),
    nextLoudness: null,
  };
  render(<ConsoleBoard {...props} />);
  const fader = screen.getByTestId("console-fader");
  // a 126 px rail: 100 px of travel for 0-100 (the cap is 26 px)
  vi.spyOn(fader, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 226, height: 126, left: 0, right: 48, width: 48, x: 0, y: 100, toJSON() {} } as DOMRect);
  vi.spyOn(fader, "hasPointerCapture").mockReturnValue(true);
  return fader;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CONSOLE · the channel fader under a press", () => {
  it("a press on the cap a few px off its middle never moves the sounding track's level", () => {
    const onVolume = vi.fn();
    const fader = mount(100, onVolume);
    // value 100: the cap spans 100..126, its middle at 113; the finger lands at 118
    fireEvent.pointerDown(fader, { clientY: 118, pointerId: 1 });
    fireEvent.pointerUp(fader, { clientY: 118, pointerId: 1 });
    expect(onVolume).not.toHaveBeenCalled();
  });

  it("a drag moves the level from where it stood, by how far the finger went - past a 3 px dead zone", () => {
    const onVolume = vi.fn();
    const fader = mount(60, onVolume);
    // pressed low on the rail, far from the cap: nothing moves
    fireEvent.pointerDown(fader, { clientY: 200, pointerId: 1 });
    expect(onVolume).not.toHaveBeenCalled();
    // a 2 px wobble is still a press
    fireEvent.pointerMove(fader, { clientY: 202, pointerId: 1 });
    expect(onVolume).not.toHaveBeenCalled();
    // 25 px down = a quarter of the travel: 60 → 35
    fireEvent.pointerMove(fader, { clientY: 225, pointerId: 1 });
    expect(onVolume).toHaveBeenLastCalledWith(35);
    fireEvent.pointerUp(fader, { clientY: 225, pointerId: 1 });
    // released: a move without a press moves nothing
    onVolume.mockClear();
    fireEvent.pointerMove(fader, { clientY: 150, pointerId: 1 });
    expect(onVolume).not.toHaveBeenCalled();
  });
});
