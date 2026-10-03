import { describe, it, expect } from "vitest";
import { shouldYieldControl } from "./live-arbitration";

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

  it("claims are compared on corrected clocks: the PA, which started first, keeps the show", () => {
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

  // The review's two cases against the first cut (a 10 s window decided on raw stamps
  // whenever the raw gap was narrow): two controllers that never settle, and a
  // fast-clocked PA losing to a phone that started 5 s after it.
  it("9.95 s apart, the peer's clock a minute slow, 200 ms latency: the earlier keeps it", () => {
    const real = { a: 1_000_000, b: 1_009_950 };
    const offB = -60_000;
    const lat = 200;
    const aYields = shouldYieldControl({ mine: real.a, theirs: real.b + offB, theirsAtMyClock: real.b + lat, myId: "aaa", theirId: "zzz", mineBegun: true, theirsBegun: true });
    const bYields = shouldYieldControl({ mine: real.b + offB, theirs: real.a, theirsAtMyClock: real.a + offB + lat, myId: "zzz", theirId: "aaa", mineBegun: true, theirsBegun: true });
    expect(aYields).toBe(false);
    expect(bYields).toBe(true);
  });

  it("5 s apart, the PA's clock two minutes fast: the PA, which started first, keeps it", () => {
    const real = { pa: 2_000_000, phone: 2_005_000 };
    const offPa = 120_000;
    const paYields = shouldYieldControl({ mine: real.pa + offPa, theirs: real.phone, theirsAtMyClock: real.phone + offPa + 100, myId: "aaa", theirId: "zzz", mineBegun: true, theirsBegun: true });
    const phoneYields = shouldYieldControl({ mine: real.phone, theirs: real.pa + offPa, theirsAtMyClock: real.pa + 100, myId: "zzz", theirId: "aaa", mineBegun: true, theirsBegun: true });
    expect(paYields).toBe(false);
    expect(phoneYields).toBe(true);
  });

  // The property, over clock offsets of up to 10 minutes either way and latencies of up
  // to 2 s each way. ONE exchange: never both yield (a show with no controller), both
  // keep only when the STARTs were within a latency of each other, and otherwise the
  // earlier START keeps it. A SECOND exchange (each re-asserting AT the other) always
  // leaves exactly one.
  it("one exchange never leaves no controller; insisting always settles to exactly one", () => {
    const offsets = [-600_000, -120_000, -15_000, -2_000, 0, 2_000, 15_000, 120_000, 600_000];
    const gaps = [0, 50, 400, 1_500, 2_900, 3_100, 6_000, 9_950, 30_000, 300_000];
    const lats = [0, 120, 500, 2_000];
    for (const offB of offsets) {
      for (const gap of gaps) {
        for (const sign of [1, -1]) {
          for (const latAB of lats) {
            for (const latBA of lats) {
              const realA = 5_000_000;
              const realB = realA + sign * gap;
              const stampA = realA; // A's clock is the reference
              const stampB = realB + offB;
              // A hears B: correction = A.now - B.sentAt = -offB + latBA (B -> A)
              const a = { mine: stampA, theirs: stampB, theirsAtMyClock: stampB - offB + latBA, myId: "aaa", theirId: "zzz", mineBegun: true, theirsBegun: true };
              const b = { mine: stampB, theirs: stampA, theirsAtMyClock: stampA + offB + latAB, myId: "zzz", theirId: "aaa", mineBegun: true, theirsBegun: true };
              const aYields = shouldYieldControl(a);
              const bYields = shouldYieldControl(b);
              const label = `gap=${sign * gap} offB=${offB} lat=${latAB}/${latBA}`;
              expect(aYields && bYields, `both yielded at ${label}`).toBe(false);
              if (gap > Math.max(latAB, latBA)) {
                expect(aYields !== bYields, `both kept at ${label}`).toBe(true);
                expect(aYields, `the later START kept it at ${label}`).toBe(sign < 0);
              }
              if (!aYields && !bYields) {
                const a2 = shouldYieldControl({ ...a, theyInsistOnMe: true });
                const b2 = shouldYieldControl({ ...b, theyInsistOnMe: true });
                expect(a2 !== b2, `insisting did not settle ${label}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("a stray insist at a device that is clearly earlier only falls back to the raw stamps, which agree", () => {
    // A started 30 s before B on agreeing clocks: B yields at once, and B never insists.
    // Should a stray insist reach A anyway, A only falls back to the raw stamps - which
    // say the same thing here.
    expect(shouldYieldControl({ mine: 1_000, theirs: 31_000, theirsAtMyClock: 31_100, theyInsistOnMe: true, myId: "aaa", theirId: "zzz", mineBegun: true, theirsBegun: true })).toBe(false);
  });
});

// A claim is a run's START, and the earlier one wins - so an OLD run must not count.
describe("shouldYieldControl: a run that is not the show", () => {
  const both = { mineBegun: true, theirsBegun: true };

  it("a show still ON beats one that was ended, whichever started first", () => {
    // this afternoon's run-through, ended with จบโชว์, against tonight's show
    expect(shouldYieldControl({ mine: 1_000, theirs: 9_000, myId: "aaa", theirId: "zzz", ...both, mineEnded: true })).toBe(true);
    expect(shouldYieldControl({ mine: 9_000, theirs: 1_000, myId: "zzz", theirId: "aaa", ...both, theirsEnded: true })).toBe(false);
  });

  it("a phone back with this afternoon's rehearsal loses to the show started while it was away", () => {
    // phone: rehearsal from 17:00, page closed at 17:30, reopened at 20:10
    // PA: started tonight's show at 20:00
    const phone = { claim: 1_700, away: { from: 1_730, to: 2_010 } };
    const pa = { claim: 2_000 };
    const phoneYields = shouldYieldControl({ mine: phone.claim, theirs: pa.claim, theirsAtMyClock: pa.claim, myAbsence: phone.away, myId: "zzz", theirId: "aaa", ...both });
    const paYields = shouldYieldControl({ mine: pa.claim, theirs: phone.claim, theirsAtMyClock: phone.claim, theirAbsenceAtMyClock: phone.away, myId: "aaa", theirId: "zzz", ...both });
    expect(phoneYields).toBe(true);
    expect(paYields).toBe(false);
  });

  it("the first device back from a reload keeps the show when nothing started while it was away", () => {
    // PA started at 20:00, reloaded 20:30-20:31; a phone that could not hear it started at 20:40
    const pa = { claim: 2_000, away: { from: 2_030, to: 2_031 } };
    const phone = { claim: 2_040 };
    expect(shouldYieldControl({ mine: pa.claim, theirs: phone.claim, theirsAtMyClock: phone.claim, myAbsence: pa.away, myId: "aaa", theirId: "zzz", ...both })).toBe(false);
    expect(shouldYieldControl({ mine: phone.claim, theirs: pa.claim, theirsAtMyClock: pa.claim, theirAbsenceAtMyClock: pa.away, myId: "zzz", theirId: "aaa", ...both })).toBe(true);
  });

  it("an absence that holds neither START changes nothing", () => {
    const away = { from: 5_000, to: 6_000 };
    expect(shouldYieldControl({ mine: 1_000, theirs: 2_000, theirsAtMyClock: 2_000, myAbsence: away, myId: "aaa", theirId: "zzz", ...both })).toBe(false);
  });
});
