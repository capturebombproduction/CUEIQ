// lib/member-order.ts - Artists' "เรียงตามเลขไมค์". The plan is what gets WRITTEN to
// members.sort_order, the order a band stands in on every screen: a wrong plan reorders a
// lineup on show day, a plan that is never empty rewrites the roster on every press.
import { describe, it, expect } from "vitest";
import { micOrderPlan } from "./member-order";

const m = (id: string, mic: number | null, sort_order: number, left_at: string | null = null) => ({
  id,
  mic_number: mic,
  sort_order,
  left_at,
});
/** The ids in the order the plan leaves them (rows the plan does not name keep their number). */
const after = (rows: ReturnType<typeof m>[]) => {
  const plan = new Map(micOrderPlan(rows).map((p) => [p.id, p.to]));
  return rows
    .map((r) => ({ id: r.id, n: plan.get(r.id) ?? r.sort_order }))
    .sort((a, b) => a.n - b.n)
    .map((r) => r.id);
};

describe("micOrderPlan", () => {
  it("puts the roster in mic order, 1 2 3 …, naming only the rows that move", () => {
    // Seishin on 2026-11-08: Yuki (mic 2) stood first, FrenchFry (mic 1) third
    const rows = [m("yuki", 2, 1), m("cherrie", 3, 2), m("frenchfry", 1, 3), m("tintin", 4, 4)];
    expect(micOrderPlan(rows)).toEqual([
      { id: "frenchfry", from: 3, to: 1 },
      { id: "yuki", from: 1, to: 2 },
      { id: "cherrie", from: 2, to: 3 },
    ]);
    expect(after(rows)).toEqual(["frenchfry", "yuki", "cherrie", "tintin"]);
  });

  it("a roster already in mic order has nothing to write - gaps in the numbers are not a reason", () => {
    expect(micOrderPlan([m("a", 1, 1), m("b", 2, 2), m("c", 3, 3)])).toEqual([]);
    expect(micOrderPlan([m("a", 1, 1), m("b", 2, 2), m("c", 3, 5)])).toEqual([]);
    expect(micOrderPlan([])).toEqual([]);
    expect(micOrderPlan([m("only", null, 4)])).toEqual([]);
  });

  it("no mic = after everyone who has one, in the order they stood", () => {
    const rows = [m("new1", null, 1), m("b", 2, 2), m("new2", null, 3), m("a", 1, 4)];
    expect(after(rows)).toEqual(["a", "b", "new1", "new2"]);
  });

  it("someone who left the band goes last, mic or not", () => {
    const rows = [m("left", 1, 1, "2026-10-27T03:00:00Z"), m("b", 2, 2), m("a", 1, 3), m("nomic", null, 4)];
    expect(after(rows)).toEqual(["a", "b", "nomic", "left"]);
  });

  it("two people on one mic number keep their order (it never flips back and forth)", () => {
    const rows = [m("x", 3, 1), m("first", 1, 2), m("second", 1, 3)];
    expect(after(rows)).toEqual(["first", "second", "x"]);
    // pressing again after the first plan was written: nothing left to do
    const plan = new Map(micOrderPlan(rows).map((p) => [p.id, p.to]));
    const written = rows.map((r) => ({ ...r, sort_order: plan.get(r.id) ?? r.sort_order }));
    expect(micOrderPlan(written)).toEqual([]);
  });

  it("two rows on one sort_order are told apart: the plan gives every row its own number", () => {
    // two Ar adding a member at the same moment both took max + 1
    const rows = [m("a", 1, 1), m("b", 2, 2), m("c", 3, 2)];
    expect(micOrderPlan(rows)).toEqual([{ id: "c", from: 2, to: 3 }]);
  });

  it("reads the rows in any array order (the page hands them in unsorted)", () => {
    const rows = [m("tintin", 4, 4), m("frenchfry", 1, 3), m("yuki", 2, 1), m("cherrie", 3, 2)];
    expect(after(rows)).toEqual(["frenchfry", "yuki", "cherrie", "tintin"]);
  });
});
