// components/live/signal-strip.tsx - the loop that turns tap readings into the meters and the
// NO SIGNAL verdict. The tap is faked (the real one needs Chromium: the desktop smoke runs it);
// the clock and the animation frames are stepped by hand.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { SignalStrip } from "./signal-strip";
import type { SignalReading, SignalTap } from "@/lib/live-signal";

let frames: FrameRequestCallback[] = [];
let clock = 0;
let level = 0.1;
let ready = true;
const tap = { read: (): SignalReading => ({ ready, rmsL: level, rmsR: level, peakL: level * 1.4, peakR: level * 1.4 }) } as unknown as SignalTap;
const player = { currentTime: 30, duration: 240, volume: 1, muted: false, paused: false } as HTMLMediaElement;

/** Advance `ms` of wall time in 100 ms frames, the playhead moving with it. */
function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    clock += 100;
    (player as { currentTime: number }).currentTime += 0.1;
    const run = frames;
    frames = [];
    act(() => run.forEach((f) => f(clock)));
  }
}

beforeEach(() => {
  frames = [];
  clock = 0;
  level = 0.1;
  ready = true;
  Object.assign(player, { currentTime: 30, volume: 1, muted: false, paused: false });
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (frames.push(f), frames.length));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => vi.unstubAllGlobals());

const mount = (onVerdict = vi.fn(), sounding = true) =>
  render(<SignalStrip tap={tap} player={() => player} sounding={sounding} trackKey="item-1" waveform={[]} onVerdict={onVerdict} />);

describe("SignalStrip", () => {
  it("renders nothing without a tap (the web build)", () => {
    const { container } = render(
      <SignalStrip tap={null} player={() => null} sounding trackKey="x" waveform={[]} onVerdict={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the level that leaves the app, and the volume applied to it", () => {
    mount();
    advance(500);
    expect(screen.getByTestId("signal-strip").dataset.ready).toBe("1");
    const db = () => screen.getByTestId("signal-strip").querySelector("span.num.w-\\[46px\\]")!.textContent;
    expect(Number(db()!.replace("−", "-"))).toBeCloseTo(20 * Math.log10(0.14), 0); // the held peak
    (player as { volume: number }).volume = 0; // AUTO MUTE
    advance(1500); // past the peak hold
    expect(db()).toBe("−∞");
  });

  it("raises NO SIGNAL once a playing file has been silent long enough - and clears it", () => {
    const onVerdict = vi.fn();
    mount(onVerdict);
    advance(4000); // through the start grace, with sound
    level = 0;
    advance(2900);
    expect(onVerdict).not.toHaveBeenCalledWith("silent");
    advance(300);
    expect(onVerdict).toHaveBeenLastCalledWith("silent");
    level = 0.1;
    advance(100);
    expect(onVerdict).toHaveBeenLastCalledWith(null);
  });

  it("a fader pulled down on purpose is not a fault: AUTO MUTE never raises NO SIGNAL", () => {
    const onVerdict = vi.fn();
    mount(onVerdict);
    (player as { volume: number }).volume = 0;
    advance(10000);
    expect(onVerdict).not.toHaveBeenCalledWith("silent");
  });

  it("says nothing until the tap runs, nor on a device that is not sounding the show", () => {
    const a = vi.fn();
    ready = false;
    level = 0;
    mount(a);
    advance(10000);
    expect(a).not.toHaveBeenCalledWith("silent");
    expect(screen.getByTestId("signal-strip").dataset.ready).toBe("0");
  });

  it("not sounding (a muted remote, or a paused show): no verdict", () => {
    const a = vi.fn();
    level = 0;
    mount(a, false);
    advance(10000);
    expect(a).not.toHaveBeenCalledWith("silent");
  });
});
