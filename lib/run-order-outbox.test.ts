import { describe, expect, it } from "vitest";
import {
  classifyReplay,
  compactPatch,
  mergeOp,
  type RunSeqOp,
} from "@/lib/run-order-outbox";

function op(over: Partial<RunSeqOp> = {}): RunSeqOp {
  return {
    rowId: "r1",
    festival: "La famiglia · 2026-08-09",
    patch: {},
    expect: {},
    label: "กด",
    queuedAt: 1000,
    ...over,
  };
}

describe("mergeOp", () => {
  it("the first press for a row is taken as-is", () => {
    const first = op({ patch: { status: "live" }, expect: { status: "pending" } });
    expect(mergeOp(undefined, first)).toEqual(first);
  });

  // The whole reason this file exists. Offline, the caller starts a row and then
  // nudges it +5. The second press's precondition describes state THIS DEVICE
  // created — the server has never seen "live". Replaying that precondition would
  // match zero rows forever and the row would be stuck in the queue for good.
  it("keeps the FIRST precondition — the last server state we actually saw", () => {
    const start = op({
      patch: { status: "live", actual_start: "T1", offset_min: 2 },
      expect: { status: "pending" },
      label: "เริ่ม",
    });
    const nudge = op({
      patch: { offset_min: 7 },
      expect: { status: "live", offset_min: 2 },
      label: "+5 นาที",
      queuedAt: 2000,
    });
    const merged = mergeOp(start, nudge);
    expect(merged.expect).toEqual({ status: "pending" });
    expect(merged.patch).toEqual({
      status: "live",
      actual_start: "T1",
      offset_min: 7,
    });
  });

  it("takes the latest value of each column and the latest label", () => {
    const a = op({ patch: { status: "live", offset_min: 1 }, label: "เริ่ม" });
    const b = op({ patch: { status: "done", actual_end: "T9" }, label: "จบ" });
    const merged = mergeOp(a, b);
    expect(merged.patch).toEqual({
      status: "done",
      offset_min: 1,
      actual_end: "T9",
    });
    expect(merged.label).toBe("จบ");
  });

  it("keeps the original queuedAt so the chip shows how long it has been waiting", () => {
    expect(mergeOp(op({ queuedAt: 500 }), op({ queuedAt: 9000 })).queuedAt).toBe(500);
  });

  // A parked row is a decision a human has not made yet. A later press must not
  // quietly un-park it and go back to trying to overwrite whatever is on the server.
  it("a parked op stays parked when another press folds into it", () => {
    expect(mergeOp(op({ conflict: true }), op()).conflict).toBe(true);
  });

  it("does not resurrect a precondition when the first op had none", () => {
    const merged = mergeOp(
      op({ patch: { offset_min: 3 }, expect: {} }),
      op({ patch: { offset_min: 8 }, expect: { offset_min: 3 } })
    );
    expect(merged.expect).toEqual({});
    expect(merged.patch).toEqual({ offset_min: 8 });
  });

  it("null is a real value, not an absent one (clearing offset_min)", () => {
    const merged = mergeOp(
      op({ patch: { offset_min: 5 } }),
      op({ patch: { offset_min: null } })
    );
    expect(merged.patch.offset_min).toBeNull();
  });
});

describe("compactPatch", () => {
  // The flush walks `expect` as `v == null ? IS NULL : = v`. An undefined key would
  // therefore replay as "this column must currently BE NULL" — a precondition
  // nobody asked for, failing forever and parking the row as a false conflict.
  it("drops undefined, because undefined would replay as IS NULL", () => {
    expect(
      compactPatch({ status: "live", offset_min: undefined, actual_end: undefined })
    ).toEqual({ status: "live" });
  });

  // …but a real null IS a value: clearing offset_min must survive.
  it("keeps null, which is a value", () => {
    expect(compactPatch({ offset_min: null })).toEqual({ offset_min: null });
  });

  it("keeps a falsy zero", () => {
    expect(compactPatch({ offset_min: 0, buffer_seconds: 0 })).toEqual({
      offset_min: 0,
      buffer_seconds: 0,
    });
  });

  it("an all-undefined patch compacts to no precondition at all", () => {
    expect(compactPatch({ status: undefined, offset_min: undefined })).toEqual({});
  });
});

describe("classifyReplay", () => {
  it("rows matched → it landed", () => {
    expect(classifyReplay(1, true)).toBe("done");
  });

  // The builder deleted the slot while the caller was offline. An UPDATE cannot
  // resurrect a row, so re-queueing it would retry forever.
  it("nothing matched and the row is gone → drop it", () => {
    expect(classifyReplay(0, false)).toBe("dropped");
  });

  // Someone else drove the board. Not ours to overwrite, not ours to throw away.
  it("nothing matched but the row is still there → park it for a human", () => {
    expect(classifyReplay(0, true)).toBe("conflict");
  });

  it("a deleted row is dropped even if several ops matched nothing", () => {
    expect(classifyReplay(0, false)).toBe("dropped");
    expect(classifyReplay(2, true)).toBe("done");
  });
});
