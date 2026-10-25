import { describe, expect, it } from "vitest";
import { fileElapsed, padProgress, padState, padSub, padTimes, soundingCount, trimTick, type PadSound } from "./pad-view";

const on = (over: Partial<PadSound> = {}): PadSound => ({ elapsed: 30, total: 200, fadeAt: null, level: null, ...over });

describe("a pad's state", () => {
  it("green while it sounds, fading once its fade began, grey once played, yellow before", () => {
    expect(padState(on(), false)).toBe("on");
    expect(padState(on(), true)).toBe("on"); // an encore sounds green again
    expect(padState(on({ fadeAt: 1 }), true)).toBe("fade");
    expect(padState(undefined, true)).toBe("played");
    expect(padState(undefined, false)).toBe("ready");
  });
});

describe("a pad's small line", () => {
  it("what is left of the file while it sounds", () => {
    expect(padSub("on", on({ elapsed: 30, total: 200 }), 0)).toBe("−2:50");
    // a file whose length is not known yet: how far in it is
    expect(padSub("on", on({ elapsed: 75, total: 0 }), 0)).toBe("1:15");
  });

  it("its fade counts down Auto Mute's 3 s, never to 0", () => {
    expect(padSub("fade", on({ fadeAt: 1_000 }), 1_000)).toBe("เฟด 3 วิ");
    expect(padSub("fade", on({ fadeAt: 1_000 }), 2_200)).toBe("เฟด 2 วิ");
    expect(padSub("fade", on({ fadeAt: 1_000 }), 3_990)).toBe("เฟด 1 วิ");
    expect(padSub("fade", on({ fadeAt: 1_000 }), 9_000)).toBe("เฟด 1 วิ");
  });

  it("grey says it has played; yellow says nothing", () => {
    expect(padSub("played", undefined, 0)).toBe("เล่นแล้ว");
    expect(padSub("ready", undefined, 0)).toBe("");
  });
});

describe("the tile's times and the pad's progress", () => {
  it("elapsed / length while it sounds, its length otherwise", () => {
    expect(padTimes(on({ elapsed: 8, total: 228 }), 240)).toBe("0:08 / 3:48");
    expect(padTimes(undefined, 240)).toBe("4:00");
    // the file's length unknown: the row's
    expect(padTimes(on({ elapsed: 8, total: 0 }), 240)).toBe("0:08 / 4:00");
  });

  it("progress runs 0..1 over the file", () => {
    expect(padProgress(on({ elapsed: 50, total: 200 }))).toBe(0.25);
    expect(padProgress(on({ elapsed: 500, total: 200 }))).toBe(1);
    expect(padProgress(on({ total: 0 }))).toBe(0);
    expect(padProgress(undefined)).toBe(0);
  });

  it("a looping row goes round its file; any other stops at the end", () => {
    expect(fileElapsed(130, 60, true)).toBe(10);
    expect(fileElapsed(130, 60, false)).toBe(60);
    expect(fileElapsed(130, 0, true)).toBe(130);
    expect(fileElapsed(-3, 60, false)).toBe(0);
  });
});

describe("the −14 LUFS mark on a tile's fader", () => {
  it("where the fader would come down to: only for a song louder than −14", () => {
    expect(trimTick(-2)).toBeCloseTo(0.79, 2); // −2 dB = 79 % of full
    expect(trimTick(0)).toBeNull();
    expect(trimTick(null)).toBeNull();
  });
});

describe("how many pads sound", () => {
  it("counts what sounds - a fading pad is on its way out", () => {
    expect(soundingCount({ a: on(), b: on({ fadeAt: 5 }), c: on() })).toBe(2);
    expect(soundingCount({})).toBe(0);
  });
});
