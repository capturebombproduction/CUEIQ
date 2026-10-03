import { describe, it, expect } from "vitest";
import { shouldYieldControl, CLAIM_SKEW_TRUST_MS } from "./live-arbitration";

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

  // พี่ 2026-10-04: the device that started the show keeps it. There is no take-over,
  // so a later START (two presses at once, or a device that started its own show
  // while it could not hear the first one) is the one that steps down.
  it("gives control to the EARLIER claim - the first device keeps the show", () => {
    const { aYields, bYields } = settle(1000, 2000);
    expect(aYields).toBe(false);
    expect(bYields).toBe(true);
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

  // …and it outranks a claim too: a claim held on a page where no show is running
  // must not be able to take one off a machine mid-song.
  it("a running show outranks even a real claim held by an idle device", () => {
    const { aYields, bYields } = settle(null, 9999, "aaa", "bbb", true, false);
    expect(aYields).toBe(false);
    expect(bYields).toBe(true);
  });

  it("when both are running, the old claim rules decide as before", () => {
    expect(settle(null, 1000, "aaa", "bbb", true, true).aYields).toBe(true);
    // two running shows: the one started first is the show
    expect(settle(2000, 1000, "aaa", "bbb", true, true).aYields).toBe(true);
    expect(settle(1000, 2000, "aaa", "bbb", true, true).aYields).toBe(false);
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

// Two devices, two clocks. Real time: the PA started at 1_000_000, the phone (which could
// not hear it) started its own show a minute later, at 1_060_000. The PA's clock runs
// two minutes FAST, so its stamp reads 1_120_000 - judged raw, it looks LATER than the
// phone's and the PA would hand the show to the phone that started after it.
describe("shouldYieldControl across clocks", () => {
  const SKEW = 120_000; // PA clock - phone clock
  const pa = { claim: 1_120_000, id: "aaa" }; // on the PA's clock
  const phone = { claim: 1_060_000, id: "zzz" }; // on the phone's clock

  it("a wide gap is judged on the corrected clocks: the PA, which started first, keeps the show", () => {
    const paYields = shouldYieldControl({
      mine: pa.claim,
      theirs: phone.claim,
      theirsAtMyClock: phone.claim + SKEW,
      myId: pa.id,
      theirId: phone.id,
      mineBegun: true,
      theirsBegun: true,
    });
    const phoneYields = shouldYieldControl({
      mine: phone.claim,
      theirs: pa.claim,
      theirsAtMyClock: pa.claim - SKEW,
      myId: phone.id,
      theirId: pa.id,
      mineBegun: true,
      theirsBegun: true,
    });
    expect(paYields).toBe(false);
    expect(phoneYields).toBe(true);
  });

  it("a narrow gap (two presses at once) is judged on the raw stamps - the same verdict on both sides even when latency tips the correction", () => {
    // corrected gaps of +40 ms on one side and +60 ms on the other: both under the trust
    // window, so neither side uses them
    const a = shouldYieldControl({ mine: 5_000, theirs: 5_050, theirsAtMyClock: 5_040, myId: "aaa", theirId: "zzz", mineBegun: true, theirsBegun: true });
    const b = shouldYieldControl({ mine: 5_050, theirs: 5_000, theirsAtMyClock: 5_060, myId: "zzz", theirId: "aaa", mineBegun: true, theirsBegun: true });
    expect(a !== b).toBe(true);
    expect(a).toBe(false); // raw: 5_000 is earlier
  });

  it("the trust window is far above a message's latency and far below a show", () => {
    expect(CLAIM_SKEW_TRUST_MS).toBeGreaterThanOrEqual(5_000);
    expect(CLAIM_SKEW_TRUST_MS).toBeLessThanOrEqual(60_000);
  });
});
