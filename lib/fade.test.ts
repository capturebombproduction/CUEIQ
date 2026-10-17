import { afterEach, describe, expect, it, vi } from "vitest";
import { FADE_FALLBACK_MS, fadeLevel, nextFadeFrame } from "./fade";

const dB = (pct: number) => 20 * Math.log10(pct / 100);

describe("fadeLevel - a fader's curve between two levels", () => {
  it("starts and lands exactly where it was told", () => {
    expect(fadeLevel(100, 0, 0)).toBe(100);
    expect(fadeLevel(100, 0, 1)).toBe(0);
    expect(fadeLevel(100, 30, 1)).toBe(30);
    expect(fadeLevel(30, 100, 1)).toBe(100);
  });

  it("half way out of an Auto Mute is near -18 dB - a straight line was still at -6 dB", () => {
    expect(dB(fadeLevel(100, 0, 0.5))).toBeCloseTo(-18.06, 1);
    expect(dB(fadeLevel(100, 0, 0.25))).toBeGreaterThan(-9);
  });

  it("only ever moves toward the target, in either direction", () => {
    for (const [a, b] of [[100, 0], [100, 30], [0, 100], [30, 100], [55, 54]]) {
      let prev = fadeLevel(a, b, 0);
      for (let i = 1; i <= 100; i++) {
        const v = fadeLevel(a, b, i / 100);
        if (b < a) expect(v).toBeLessThanOrEqual(prev);
        else expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("holds out-of-range input to 0..100 and p to 0..1", () => {
    expect(fadeLevel(140, 0, 0)).toBe(100);
    expect(fadeLevel(100, -5, 2)).toBe(0);
    expect(fadeLevel(100, 0, -1)).toBe(100);
  });
});

describe("nextFadeFrame - a frame, or a timer when no frame comes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("steps once on the frame, and the timer never steps it again", () => {
    vi.useFakeTimers();
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((frame = cb), 7));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const step = vi.fn();
    nextFadeFrame(step);
    frame!(123);
    vi.advanceTimersByTime(FADE_FALLBACK_MS * 2);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith(123);
  });

  it("a hidden page draws no frame: the timer steps it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const step = vi.fn();
    nextFadeFrame(step);
    vi.advanceTimersByTime(FADE_FALLBACK_MS - 1);
    expect(step).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("cancelled, it never steps", () => {
    vi.useFakeTimers();
    let frame: FrameRequestCallback | null = null;
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((frame = cb), 7));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const step = vi.fn();
    nextFadeFrame(step)();
    expect(cancel).toHaveBeenCalledWith(7);
    frame!(1);
    vi.advanceTimersByTime(FADE_FALLBACK_MS * 2);
    expect(step).not.toHaveBeenCalled();
  });

  it("a frame that answers at once steps once and leaves no timer behind", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(5), 7));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const step = vi.fn();
    nextFadeFrame(step);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(FADE_FALLBACK_MS * 2);
    expect(step).toHaveBeenCalledTimes(1);
  });
});
