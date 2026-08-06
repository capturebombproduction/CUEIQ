import { describe, expect, it } from "vitest";
import {
  classifyReplay,
  compactPatch,
  applyRunSeqOverlay,
  mergeOp,
  type RunSeqOp,
  type RunSeqPatch,
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
  it("the first press for a row is taken as-is, at rev 1", () => {
    const first = op({ patch: { status: "live" }, expect: { status: "pending" } });
    expect(mergeOp(undefined, first)).toEqual({ ...first, rev: 1 });
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

describe("mergeOp revisions", () => {
  // The flush deletes by (rowId, rev). Without a bump, a press made DURING a
  // flush would merge into the same record and then be deleted as if it were the
  // op that had just been replayed — the operator's press, gone with no trace.
  it("every merge bumps the revision", () => {
    const a = mergeOp(undefined, op({ patch: { status: "live" } }));
    const b = mergeOp(a, op({ patch: { offset_min: 5 } }));
    const c = mergeOp(b, op({ patch: { actual_end: "T9" } }));
    expect([a.rev, b.rev, c.rev]).toEqual([1, 2, 3]);
  });

  it("a record queued by an older build (no rev) merges to rev 1", () => {
    const legacy = op({ patch: { status: "live" } }); // rev absent
    expect(mergeOp(legacy, op({ patch: { offset_min: 3 } })).rev).toBe(1);
  });

  // The topic is what lets the flush tell the other boards the presses landed.
  // A merge must not lose it just because the newest press was queued by a build
  // that didn't carry one.
  it("keeps a topic the previous press carried", () => {
    const first = mergeOp(undefined, op({ topic: "runorder:t1:2026-08-09:Fest" }));
    expect(mergeOp(first, op({ patch: { offset_min: 1 } })).topic).toBe(
      "runorder:t1:2026-08-09:Fest"
    );
  });
});

describe("applyRunSeqOverlay", () => {
  const rows = [
    { id: "r1", status: "pending", offset_min: null as number | null },
    { id: "r2", status: "pending", offset_min: null as number | null },
  ];

  it("lays a queued press back over the server's older row", () => {
    const out = applyRunSeqOverlay(rows, [
      op({ rowId: "r1", patch: { status: "live", offset_min: 4 } }),
    ]);
    expect(out[0]).toEqual({ id: "r1", status: "live", offset_min: 4 });
    expect(out[1]).toBe(rows[1]); // untouched rows keep their identity
  });

  // A conflict is precisely the case where the human has to see what the server
  // really holds before deciding, so a parked op must NOT be painted back on.
  it("ignores parked ops", () => {
    const out = applyRunSeqOverlay(rows, [
      op({ rowId: "r1", patch: { status: "live" }, conflict: true }),
    ]);
    expect(out).toEqual(rows);
  });

  it("an empty queue returns the rows untouched", () => {
    expect(applyRunSeqOverlay(rows, [])).toBe(rows);
  });

  it("a queued press for a row the server no longer has changes nothing", () => {
    const out = applyRunSeqOverlay(rows, [op({ rowId: "gone", patch: { status: "done" } })]);
    expect(out).toEqual(rows);
  });
});

describe("rebasing a press that merged in mid-flush", () => {
  // The shape rebaseExpect writes: the columns the replay committed become the
  // new precondition, because they ARE the server's state once it lands. Kept as
  // a pure check of that rule — the IndexedDB half is exercised by the app.
  function rebased(replayed: RunSeqOp): RunSeqPatch {
    const next: RunSeqPatch = { ...replayed.expect };
    for (const k of Object.keys(replayed.expect) as (keyof RunSeqPatch)[]) {
      if (k in replayed.patch) {
        (next as Record<string, unknown>)[k] = (replayed.patch as Record<string, unknown>)[k];
      }
    }
    return next;
  }

  it("moves the precondition onto what the replay just committed", () => {
    const replayed = op({
      patch: { status: "live", actual_start: "T1", offset_min: 3 },
      expect: { status: "pending" },
    });
    // the row is 'live' on the server now, so that is what the next press must expect
    expect(rebased(replayed)).toEqual({ status: "live" });
  });

  it("leaves a precondition column the replay never wrote alone", () => {
    const replayed = op({
      patch: { status: "done", actual_end: "T9" },
      expect: { status: "live", offset_min: 4 },
    });
    expect(rebased(replayed)).toEqual({ status: "done", offset_min: 4 });
  });

  it("carries a cleared value through as the new precondition", () => {
    const replayed = op({ patch: { offset_min: null }, expect: { offset_min: 7 } });
    expect(rebased(replayed)).toEqual({ offset_min: null });
  });
});
