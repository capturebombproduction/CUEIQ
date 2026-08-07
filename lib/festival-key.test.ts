import { describe, it, expect } from "vitest";
import {
  describeFestivalMovePlan,
  festivalKeyChanged,
  normalizeFestivalKey,
  planFestivalMove,
  sameFestivalKey,
} from "./festival-key";

describe("normalizeFestivalKey — compare what the write path actually stores", () => {
  it("trims the name, because the form does before saving", () => {
    expect(normalizeFestivalKey("  SPORT DAY  ", "2026-09-05")).toEqual({
      name: "SPORT DAY",
      date: "2026-09-05",
    });
  });

  it("treats an empty date input as NULL, because that is what is stored", () => {
    expect(normalizeFestivalKey("X", "").date).toBeNull();
    expect(normalizeFestivalKey("X", null).date).toBeNull();
    expect(normalizeFestivalKey("X", undefined).date).toBeNull();
  });

  it("a missing name is an empty string, not a crash", () => {
    expect(normalizeFestivalKey(null, null)).toEqual({ name: "", date: null });
  });
});

describe("festivalKeyChanged — a false positive costs the user a scary dialog they did not earn", () => {
  it("is false for cosmetic edits that store the same key", () => {
    const before = normalizeFestivalKey("SPORT DAY", "2026-09-05");
    expect(festivalKeyChanged(before, normalizeFestivalKey("  SPORT DAY  ", "2026-09-05"))).toBe(
      false
    );
    const noDate = normalizeFestivalKey("X", null);
    expect(festivalKeyChanged(noDate, normalizeFestivalKey("X", ""))).toBe(false);
  });

  it("is true when the name moves", () => {
    expect(
      festivalKeyChanged(
        normalizeFestivalKey("SPORT DAY", "2026-09-05"),
        normalizeFestivalKey("SPORT DAY 2026", "2026-09-05")
      )
    ).toBe(true);
  });

  it("is true when only the DATE moves — the half people forget", () => {
    expect(
      festivalKeyChanged(
        normalizeFestivalKey("SPORT DAY", "2026-09-05"),
        normalizeFestivalKey("SPORT DAY", "2026-09-06")
      )
    ).toBe(true);
  });

  it("is true when a dated festival loses its date entirely", () => {
    // This is the worst one in production: the old board matches no card on any screen, so
    // nothing in the product can reach it again — not to read it, not to delete it.
    expect(
      festivalKeyChanged(
        normalizeFestivalKey("SPORT DAY", "2026-09-05"),
        normalizeFestivalKey("SPORT DAY", null)
      )
    ).toBe(true);
  });

  it("sameFestivalKey is its exact inverse", () => {
    const a = normalizeFestivalKey("A", "2026-01-01");
    expect(sameFestivalKey(a, { ...a })).toBe(true);
    expect(sameFestivalKey(a, { ...a, date: null })).toBe(false);
  });
});

/*
 * 🔴 WHAT THESE TESTS ARE REALLY PINNING: that this module NEVER authorises a write.
 *
 * Two versions of a board-mover lived here for a few hours each. The first moved every row
 * under the old key and so dragged a shared festival's board away from seven other bands.
 * The second moved only on "proof" that this event was the board's sole member — proof
 * computed from a sibling-event count that RLS filters to 0 for a band's Ar, the very person
 * the feature was for. Both were deleted.
 *
 * So there is no "move" outcome to test any more, and that absence is the point: if a future
 * change reintroduces one, `planFestivalMove`'s type no longer has a shape for it and these
 * tests stop compiling. What is left decides only how loudly to warn.
 */
describe("planFestivalMove — one read, and it only ever chooses wording", () => {
  it("no board under the old key means there is nothing to ask", () => {
    expect(planFestivalMove({ rows: 0 })).toEqual({ kind: "no-board" });
  });

  it("a board that exists produces a warning carrying its real size", () => {
    expect(planFestivalMove({ rows: 24 })).toEqual({ kind: "detaches", rows: 24 });
  });

  it("an unreadable count still warns — a failed read is not a zero count", () => {
    // The very first version returned 0 for a failed read and then gated on `rows > 0`, so
    // one 503 silently turned the whole feature off while telling the user it had saved.
    expect(planFestivalMove({ rows: null })).toEqual({ kind: "unknown" });
  });
});

describe("describeFestivalMovePlan — the copy must teach the key, and promise nothing", () => {
  const before = normalizeFestivalKey("SPORT DAY", "2026-09-05");
  const after = normalizeFestivalKey("SPORT DAY 2026", "2026-09-05");

  it("says nothing at all when there is no board", () => {
    expect(describeFestivalMovePlan({ kind: "no-board" }, before, after)).toBeNull();
  });

  it("explains that the board is keyed on name+day and is shared", () => {
    const d = describeFestivalMovePlan({ kind: "detaches", rows: 24 }, before, after)!;
    expect(d.description).toContain("24");
    expect(d.description).toContain("ชื่องาน + วันที่");
    expect(d.description).toContain("ใช้ร่วมกันทุกวง");
    expect(d.description).toContain("SPORT DAY");
    expect(d.description).toContain("SPORT DAY 2026");
  });

  it("NEVER promises to move the board, in any state", () => {
    for (const plan of [
      { kind: "detaches", rows: 3 } as const,
      { kind: "unknown" } as const,
    ]) {
      const d = describeFestivalMovePlan(plan, before, after)!;
      expect(d.description).toContain("ไม่ย้ายบอร์ดให้");
      expect(d.confirmText).not.toContain("ย้าย");
    }
  });

  it("never sends staff to the festival queue page — that URL cannot exist for a stranded board", () => {
    // Every run-order route is keyed on an event id and reads THAT event's name and date, so
    // a board under a key no event holds has no page at all. An earlier draft told staff to
    // go there anyway; this test is why that cannot come back.
    for (const plan of [
      { kind: "detaches", rows: 3 } as const,
      { kind: "unknown" } as const,
    ]) {
      const d = describeFestivalMovePlan(plan, before, after)!;
      expect(d.description).not.toContain("เปิดหน้าคิวเทศกาล");
    }
  });

  it("the unknown case admits it could not read the board, without a number", () => {
    const d = describeFestivalMovePlan({ kind: "unknown" }, before, after)!;
    expect(d.description).toContain("อ่านบอร์ดไม่ได้");
    expect(d.description).not.toMatch(/\d+ ลำดับ/);
  });

  it("names what actually changed, and never prints null for an undated festival", () => {
    const dateOnly = describeFestivalMovePlan({ kind: "detaches", rows: 1 }, before, {
      name: "SPORT DAY",
      date: "2026-09-06",
    })!;
    expect(dateOnly.description).toContain("การแก้วันที่");

    const both = describeFestivalMovePlan(
      { kind: "detaches", rows: 1 },
      before,
      normalizeFestivalKey("OTHER", "2026-09-06")
    )!;
    expect(both.description).toContain("ชื่องานและวันที่");

    const undated = describeFestivalMovePlan(
      { kind: "detaches", rows: 1 },
      normalizeFestivalKey("A", null),
      normalizeFestivalKey("B", null)
    )!;
    expect(undated.description).not.toMatch(/null|undefined/);
  });
});
