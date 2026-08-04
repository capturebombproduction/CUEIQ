import { describe, it, expect } from "vitest";
import { shouldYieldControl, shouldMuteOnStepDown } from "./live-arbitration";

// The property that matters more than any individual case: whatever the inputs,
// exactly ONE of the two devices yields. Two controllers fight; zero controllers
// is a show that stops advancing with dead buttons.
function settle(
  mine: number | null,
  theirs: number | null,
  aId = "aaa",
  bId = "bbb",
  aBegun = false,
  bBegun = false
): { aYields: boolean; bYields: boolean } {
  return {
    aYields: shouldYieldControl({
      mine,
      theirs,
      myId: aId,
      theirId: bId,
      mineBegun: aBegun,
      theirsBegun: bBegun,
    }),
    // the same exchange seen from the other device: the claims swap with the ids
    bYields: shouldYieldControl({
      mine: theirs,
      theirs: mine,
      myId: bId,
      theirId: aId,
      mineBegun: bBegun,
      theirsBegun: aBegun,
    }),
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

  // The critical one. A phone that merely OPENED the live page holds the default
  // controller flag with a null claim — and so does a PA that reloaded mid-show.
  // Deciding that by comparing two random uuids meant the phone won half the time,
  // re-asserted its own empty INITIAL state as the authority, and stopped the
  // music on the machine wired to the PA.
  it("a device RUNNING a show never yields to one that has nothing, either id order", () => {
    for (const [aId, bId] of [
      ["aaa", "zzz"],
      ["zzz", "aaa"],
    ] as const) {
      const { aYields, bYields } = settle(null, null, aId, bId, true, false);
      expect(aYields, "the running show yielded").toBe(false);
      expect(bYields, "the idle page kept control").toBe(true);
    }
  });

  // …and it outranks a claim too: a device that pressed ขอควบคุม on a page where
  // no show is running must not be able to take one off a machine mid-song.
  it("a running show outranks even a real claim held by an idle device", () => {
    const { aYields, bYields } = settle(null, 9999, "aaa", "bbb", true, false);
    expect(aYields).toBe(false);
    expect(bYields).toBe(true);
  });

  it("when both are running, the old claim rules decide as before", () => {
    expect(settle(null, 1000, "aaa", "bbb", true, true).aYields).toBe(true);
    expect(settle(2000, 1000, "aaa", "bbb", true, true).aYields).toBe(false);
  });

  // A peer on an older build sends no `begun`, so both flags read false and the
  // pair must behave exactly as it did before this rule existed.
  it("stays inert when neither side reports a running show", () => {
    expect(settle(null, null, "aaa", "zzz").aYields).toBe(true);
    expect(settle(null, 1000).aYields).toBe(true);
  });

  it("still leaves exactly one controller across every begun/claim combination", () => {
    const stamps = [null, 1000, 2000] as const;
    for (const mine of stamps) {
      for (const theirs of stamps) {
        for (const aBegun of [false, true]) {
          for (const bBegun of [false, true]) {
            const { aYields, bYields } = settle(mine, theirs, "aaa", "bbb", aBegun, bBegun);
            expect(
              aYields !== bYields,
              `both ${aYields ? "yielded" : "kept control"} for mine=${mine} theirs=${theirs} aBegun=${aBegun} bBegun=${bBegun}`
            ).toBe(true);
          }
        }
      }
    }
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
