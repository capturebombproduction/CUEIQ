import { describe, it, expect } from "vitest";
import { shouldYieldControl, shouldMuteOnStepDown } from "./live-arbitration";

// The property that matters more than any individual case: whatever the inputs,
// exactly ONE of the two devices yields. Two controllers fight; zero controllers
// is a show that stops advancing with dead buttons.
function settle(
  mine: number | null,
  theirs: number | null,
  aId = "aaa",
  bId = "bbb"
): { aYields: boolean; bYields: boolean } {
  return {
    aYields: shouldYieldControl({ mine, theirs, myId: aId, theirId: bId }),
    // the same exchange seen from the other device: the claims swap with the ids
    bYields: shouldYieldControl({ mine: theirs, theirs: mine, myId: bId, theirId: aId }),
  };
}

describe("shouldYieldControl", () => {
  it("gives control to the device that actually claimed it", () => {
    const { aYields, bYields } = settle(null, 1000);
    expect(aYields).toBe(true);
    expect(bYields).toBe(false);
  });

  it("gives control to the MORE RECENT claim — ขอควบคุม has to work", () => {
    const { aYields, bYields } = settle(1000, 2000);
    expect(aYields).toBe(true);
    expect(bYields).toBe(false);
  });

  it("leaves exactly one controller when BOTH devices restored the show themselves", () => {
    // The regression this file was written for: two reloaded devices both hold the
    // default flag with no claim, and the old rule ("null always yields") had them
    // both step down — Auto stops, next/prev dead, nobody driving.
    const { aYields, bYields } = settle(null, null);
    expect(aYields !== bYields).toBe(true);
  });

  it("leaves exactly one controller when both claimed in the same millisecond", () => {
    const { aYields, bYields } = settle(1000, 1000);
    expect(aYields !== bYields).toBe(true);
  });

  it("never lets both devices keep control, and never lets both step down", () => {
    const stamps = [null, 1000, 2000] as const;
    for (const mine of stamps) {
      for (const theirs of stamps) {
        const { aYields, bYields } = settle(mine, theirs);
        expect(
          aYields !== bYields,
          `both ${aYields ? "yielded" : "kept control"} for mine=${mine} theirs=${theirs}`
        ).toBe(true);
      }
    }
  });

  it("reaches the same verdict whichever id sorts first", () => {
    expect(settle(null, null, "zzz", "aaa").aYields).toBe(false);
    expect(settle(null, null, "aaa", "zzz").aYields).toBe(true);
  });
});

describe("shouldMuteOnStepDown", () => {
  const mountedAt = 5_000;

  it("mutes a device that merely joined the show", () => {
    expect(
      shouldMuteOnStepDown({
        mine: null,
        theirsAtMyClock: 1_000,
        resumedOwnSnapshot: false,
        mountedAt,
      })
    ).toBe(true);
  });

  it("keeps a reloaded speaker sounding when it yields to the incumbent", () => {
    // The claim predates this page's life → we are re-joining, not being taken over.
    expect(
      shouldMuteOnStepDown({
        mine: null,
        theirsAtMyClock: 1_000,
        resumedOwnSnapshot: true,
        mountedAt,
      })
    ).toBe(false);
  });

  it("moves the sound when someone deliberately takes control after we loaded", () => {
    expect(
      shouldMuteOnStepDown({
        mine: null,
        theirsAtMyClock: 9_000,
        resumedOwnSnapshot: true,
        mountedAt,
      })
    ).toBe(true);
  });

  it("mutes a device that lost a claim of its own", () => {
    expect(
      shouldMuteOnStepDown({
        mine: 2_000,
        theirsAtMyClock: 3_000,
        resumedOwnSnapshot: true,
        mountedAt,
      })
    ).toBe(true);
  });

  it("does not mute on an unclaimed winner it cannot date", () => {
    // theirs=null with a resumed snapshot: the tie-break above decided this, and a
    // reloaded speaker must not be silenced by a claim that does not exist.
    expect(
      shouldMuteOnStepDown({
        mine: null,
        theirsAtMyClock: null,
        resumedOwnSnapshot: true,
        mountedAt,
      })
    ).toBe(false);
  });
});
