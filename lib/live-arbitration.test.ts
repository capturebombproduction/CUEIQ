import { describe, it, expect } from "vitest";
import { settleControl, type ControlVerdict } from "./live-arbitration";

// Both sides of one exchange: A judges B's message, B judges A's.
function settle(
  mine: number | null,
  theirs: number | null,
  aBegun = true,
  bBegun = true,
  aId = "aaa",
  bId = "bbb"
): { a: ControlVerdict; b: ControlVerdict } {
  return {
    a: settleControl({ mine, theirs, myId: aId, theirId: bId, mineBegun: aBegun, theirsBegun: bBegun }),
    b: settleControl({ mine: theirs, theirs: mine, myId: bId, theirId: aId, mineBegun: bBegun, theirsBegun: aBegun }),
  };
}

describe("settleControl", () => {
  // The property that matters more than any one case. Two RUNNING devices end with
  // exactly one controller, or - two different runs - both keep and both say so. Never
  // both yielding (a show with nobody driving it); never both keeping in silence.
  it("whatever the claims: one keeps and one yields, or both report the conflict", () => {
    const stamps = [null, 1000, 2000] as const;
    for (const mine of stamps) {
      for (const theirs of stamps) {
        for (const [aId, bId] of [["aaa", "zzz"], ["zzz", "aaa"]] as const) {
          for (const aBegun of [false, true]) {
            for (const bBegun of [false, true]) {
              const { a, b } = settle(mine, theirs, aBegun, bBegun, aId, bId);
              const label = `mine=${mine} theirs=${theirs} begun=${aBegun}/${bBegun} ids=${aId}/${bId}`;
              expect(a === "yield" && b === "yield", `both yielded: ${label}`).toBe(false);
              if (!aBegun && !bBegun) {
                // before any show nobody controls a show: both keep START
                expect([a, b], label).toEqual(["keep", "keep"]);
              } else if (a === "conflict" || b === "conflict") {
                expect([a, b], `a one-sided conflict: ${label}`).toEqual(["conflict", "conflict"]);
              } else {
                expect(a !== b, `both kept in silence: ${label}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  // A page that merely OPENED holds the default flag with a null claim. Decided by
  // comparing two random ids, it won half the time against a PA that had reloaded,
  // re-asserted its empty INITIAL state and stopped the music.
  it("a device RUNNING a show never yields to one with nothing - not even to a claim", () => {
    for (const [aId, bId] of [["aaa", "zzz"], ["zzz", "aaa"]] as const) {
      expect(settle(null, null, true, false, aId, bId)).toEqual({ a: "keep", b: "yield" });
      expect(settle(null, 9999, true, false, aId, bId)).toEqual({ a: "keep", b: "yield" });
    }
  });

  // พี่ 2026-10-04: the device that started the show keeps it, and nothing another device
  // does may move it. Two DIFFERENT runs are never settled by moving one of them.
  it("two different runs: nobody yields - a phone back with this afternoon's rehearsal", () => {
    // its run started at 17:00 (earlier), the PA's at 20:00
    expect(settle(20_00, 17_00)).toEqual({ a: "conflict", b: "conflict" });
  });

  it("two different runs: nobody yields - a phone that started while it could not hear the PA", () => {
    expect(settle(20_00, 20_05)).toEqual({ a: "conflict", b: "conflict" });
  });

  it("two different runs: nobody yields - two STARTs at once, whatever the clocks say", () => {
    expect(settle(5_000, 5_050)).toEqual({ a: "conflict", b: "conflict" });
    expect(settle(5_050, 5_000)).toEqual({ a: "conflict", b: "conflict" });
  });

  // The same run on two devices: two tabs that restored one snapshot. Either may drive -
  // it is the same show - so the ids settle it, and the other watches it.
  it("the same run on two devices: exactly one keeps it, by id", () => {
    expect(settle(1000, 1000, true, true, "aaa", "zzz")).toEqual({ a: "yield", b: "keep" });
    expect(settle(1000, 1000, true, true, "zzz", "aaa")).toEqual({ a: "keep", b: "yield" });
  });

  it("the same run on two tabs: the one SOUNDING it keeps it, whatever the ids", () => {
    for (const [aId, bId] of [["aaa", "zzz"], ["zzz", "aaa"]] as const) {
      const a = settleControl({ mine: 1000, theirs: 1000, myId: aId, theirId: bId, mineBegun: true, theirsBegun: true, mineSounding: true, theirsSounding: false });
      const b = settleControl({ mine: 1000, theirs: 1000, myId: bId, theirId: aId, mineBegun: true, theirsBegun: true, mineSounding: false, theirsSounding: true });
      expect([a, b]).toEqual(["keep", "yield"]);
    }
  });

  it("a run with a claim keeps it against one with none (a snapshot from an older build)", () => {
    expect(settle(1000, null)).toEqual({ a: "keep", b: "yield" });
  });

  it("two running devices with no claims (older builds): exactly one keeps, by id", () => {
    const { a, b } = settle(null, null);
    expect(a !== b && a !== "conflict").toBe(true);
  });

  // A peer on an older build sends no `begun`: both flags read false, and before any show
  // nobody is made a viewer.
  it("before any show nobody yields", () => {
    expect(settle(null, null, false, false)).toEqual({ a: "keep", b: "keep" });
    expect(settle(1000, 2000, false, false)).toEqual({ a: "keep", b: "keep" });
  });
});
