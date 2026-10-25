import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crowdedOut, LiveLayers, PAD_FADE_MS, type Layer } from "./live-layers";
import { FADE_FALLBACK_MS } from "./fade";

/** An audio element as far as a layer touches one: its volume and whether it plays. */
function el(volume = 1) {
  const e = {
    volume,
    paused: false,
    pauses: 0,
    pause() {
      e.paused = true;
      e.pauses++;
    },
  };
  return e;
}
const asEl = (e: ReturnType<typeof el>) => e as unknown as HTMLMediaElement;

function setup({ canFade = true } = {}) {
  const changes = vi.fn();
  const layers = new LiveLayers({ onChange: changes, canFade: () => canFade, now: () => Date.now() });
  const add = (e: ReturnType<typeof el>, itemId: string, anchor = 0, level = e.volume * 100) =>
    layers.add({ el: asEl(e), itemId, anchor, total: 200, firedAt: 0, level });
  return { layers, changes, add };
}

beforeEach(() => {
  // node has no frames: every step comes from nextFadeFrame's fallback timer, as on a hidden page
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveLayers - the rows sounding under the row on now", () => {
  it("one element is one layer, whatever adds it twice", () => {
    const { layers, add, changes } = setup();
    const a = el();
    const first = add(a, "item-1");
    expect(add(a, "item-1")).toBe(first);
    expect(layers.list()).toHaveLength(1);
    expect(layers.holds(asEl(a))).toBe(true);
    expect(layers.of("item-1")).toBe(first);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("fades out in Auto Mute's 3 s on the fader curve, then stops - and only then", () => {
    const { layers, add } = setup();
    const a = el(0.8);
    const l = add(a, "item-1");
    layers.fadeOut(l);
    expect(l.fadeAt).not.toBeNull();
    let prev = a.volume;
    for (let t = 0; t < PAD_FADE_MS - FADE_FALLBACK_MS; t += FADE_FALLBACK_MS) {
      vi.advanceTimersByTime(FADE_FALLBACK_MS);
      expect(a.volume).toBeLessThanOrEqual(prev);
      prev = a.volume;
    }
    // half way out it is far quieter than half (a fader's cube law, lib/fade.ts)
    expect(a.paused).toBe(false);
    expect(layers.list()).toHaveLength(1);
    vi.advanceTimersByTime(FADE_FALLBACK_MS * 2);
    expect(a.volume).toBe(0);
    expect(a.paused).toBe(true);
    expect(layers.list()).toHaveLength(0);
  });

  it("half way through the fade the layer is near -18 dB, not -6", () => {
    const { layers, add } = setup();
    const a = el(1);
    layers.fadeOut(add(a, "item-1"));
    vi.advanceTimersByTime(PAD_FADE_MS / 2);
    expect(20 * Math.log10(a.volume)).toBeLessThan(-15);
  });

  it("a second fade on a fading layer changes nothing (the first one's clock stands)", () => {
    const { layers, add } = setup();
    const a = el(1);
    const l = add(a, "item-1");
    layers.fadeOut(l);
    const at = l.fadeAt;
    vi.advanceTimersByTime(1_000);
    layers.fadeOut(l);
    expect(l.fadeAt).toBe(at);
    vi.advanceTimersByTime(PAD_FADE_MS - 1_000 + FADE_FALLBACK_MS);
    expect(a.paused).toBe(true);
  });

  it("where the volume cannot be set (iPhone / iPad), a fade is a stop - at once", () => {
    const { layers, add } = setup({ canFade: false });
    const a = el(1);
    layers.fadeOut(add(a, "item-1"));
    expect(a.paused).toBe(true);
    expect(layers.list()).toHaveLength(0);
  });

  it("a layer whose file ends by itself is released, never paused by us", () => {
    const { layers, add, changes } = setup();
    const a = el();
    add(a, "item-1");
    changes.mockClear();
    layers.release(asEl(a));
    expect(layers.list()).toHaveLength(0);
    expect(a.pauses).toBe(0);
    expect(changes).toHaveBeenCalledTimes(1);
    layers.release(asEl(a)); // twice: nothing more
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("released mid-fade, the fade stops writing to the element", () => {
    const { layers, add } = setup();
    const a = el(1);
    const l = add(a, "item-1");
    layers.fadeOut(l);
    vi.advanceTimersByTime(500);
    layers.release(asEl(a));
    const v = a.volume;
    vi.advanceTimersByTime(PAD_FADE_MS);
    expect(a.volume).toBe(v);
  });

  it("quiet stops every layer at once and says so once; with none it says nothing", () => {
    const { layers, add, changes } = setup();
    const [a, b] = [el(), el()];
    add(a, "item-1");
    add(b, "item-2");
    changes.mockClear();
    layers.quiet();
    expect([a.paused, b.paused]).toEqual([true, true]);
    expect(layers.list()).toHaveLength(0);
    expect(changes).toHaveBeenCalledTimes(1);
    layers.quiet();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("fadeAll fades every layer (Auto Mute is how a show ends)", () => {
    const { layers, add } = setup();
    const [a, b] = [el(), el()];
    add(a, "item-1");
    add(b, "item-2");
    layers.fadeAll();
    expect(layers.list().every((l) => l.fadeAt != null)).toBe(true);
    vi.advanceTimersByTime(PAD_FADE_MS + FADE_FALLBACK_MS);
    expect([a.paused, b.paused]).toEqual([true, true]);
  });

  it("the tile fader moves a row's sounding layer - not one already fading", () => {
    const { layers, add } = setup();
    const [a, b] = [el(1), el(1)];
    add(a, "item-1");
    const fading = add(b, "item-2");
    layers.fadeOut(fading);
    layers.setLevel("item-1", 40);
    layers.setLevel("item-2", 90);
    expect(a.volume).toBeCloseTo(0.4);
    expect(layers.of("item-1")!.level).toBe(40);
    expect(b.volume).toBeLessThanOrEqual(1);
    expect(fading.level).toBe(100);
  });
});

describe("crowdedOut - a fifth pad fades the oldest out", () => {
  const layer = (anchor: number, fadeAt: number | null = null) =>
    ({ el: asEl(el()), itemId: `i${anchor}`, anchor, total: 1, firedAt: 0, level: 100, fadeAt }) as Layer;

  it("beyond the room left, the ones whose file started first", () => {
    const ls = [layer(30), layer(10), layer(20), layer(40)];
    expect(crowdedOut(ls, 3).map((l) => l.anchor)).toEqual([10]);
    expect(crowdedOut(ls, 2).map((l) => l.anchor)).toEqual([10, 20]);
    expect(crowdedOut(ls, 4)).toEqual([]);
  });

  it("a fading layer is on its way out and takes no room", () => {
    const ls = [layer(10, 5), layer(20), layer(30), layer(40)];
    expect(crowdedOut(ls, 3)).toEqual([]);
    expect(crowdedOut(ls, 2).map((l) => l.anchor)).toEqual([20]);
  });
});
