import { describe, expect, it } from "vitest";
import {
  type ChildListOp,
  type EventScopedOp,
  type MgmtOp,
  type NewMgmtOp,
  applyPending,
  applyPendingChildren,
  childFlushDecision,
  describeOp,
  eventPatchApplied,
  fingerprintChildRows,
  isQueueableWriteError,
  isUniqueViolation,
  materializeEventRow,
  newEventId,
  nextOpRev,
  planEnqueue,
  sanitizeChildRows,
  shouldApplyOnFlush,
} from "./mgmt-outbox";

type Row = { id: string; name?: string };

describe("applyPending — overlay offline writes so they're visible", () => {
  it("returns a copy unchanged when there are no ops", () => {
    const rows: Row[] = [{ id: "a" }];
    const out = applyPending(rows, []);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows); // new array, no mutation
  });

  it("prepends a freshly-created offline event with its client id", () => {
    const rows: Row[] = [{ id: "a", name: "A" }];
    const ops: MgmtOp[] = [{ kind: "event.create", seq: 1, id: "new", values: { name: "New" } }];
    const out = applyPending(rows, ops) as Row[];
    expect(out).toEqual([{ id: "new", name: "New" }, { id: "a", name: "A" }]);
  });

  it("skips a create whose id is already present (server caught up)", () => {
    const rows: Row[] = [{ id: "dup", name: "server" }];
    const ops: MgmtOp[] = [{ kind: "event.create", seq: 1, id: "dup", values: { name: "local" } }];
    expect(applyPending(rows, ops)).toEqual([{ id: "dup", name: "server" }]);
  });

  it("patches only the matching row on update", () => {
    const rows: Row[] = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const ops: MgmtOp[] = [
      { kind: "event.update", seq: 1, id: "b", patch: { name: "B2" }, base: null },
    ];
    expect(applyPending(rows, ops)).toEqual([{ id: "a", name: "A" }, { id: "b", name: "B2" }]);
  });

  it("drops a row on delete", () => {
    const rows: Row[] = [{ id: "a" }, { id: "b" }];
    const ops: MgmtOp[] = [{ kind: "event.delete", seq: 1, id: "a", base: null }];
    expect(applyPending(rows, ops)).toEqual([{ id: "b" }]);
  });

  it("applies ops in seq order regardless of array order (create then edit)", () => {
    const ops: MgmtOp[] = [
      { kind: "event.update", seq: 2, id: "x", patch: { name: "B" }, base: null },
      { kind: "event.create", seq: 1, id: "x", values: { name: "A" } },
    ];
    // seq order: create x=A, then update x→B. Array order would lose the edit.
    expect(applyPending([], ops)).toEqual([{ id: "x", name: "B" }]);
  });

  it("does not mutate the input rows", () => {
    const rows: Row[] = [{ id: "a", name: "A" }];
    applyPending(rows, [{ kind: "event.update", seq: 1, id: "a", patch: { name: "Z" }, base: null }]);
    expect(rows).toEqual([{ id: "a", name: "A" }]);
  });
});

describe("shouldApplyOnFlush — the online-wins reconciliation guard", () => {
  const update = (base: number | null): EventScopedOp => ({
    kind: "event.update",
    id: "a",
    patch: {},
    base,
  });

  it("always applies a create (brand-new row, no base)", () => {
    const create: EventScopedOp = { kind: "event.create", id: "a", values: {} };
    expect(shouldApplyOnFlush(create, 999)).toBe(true);
  });

  it("applies when the server has NOT advanced past our base", () => {
    expect(shouldApplyOnFlush(update(1000), 1000)).toBe(true); // equal
    expect(shouldApplyOnFlush(update(1000), 900)).toBe(true); // server older
  });

  it("BLOCKS (conflict) when the server changed after our base", () => {
    expect(shouldApplyOnFlush(update(1000), 1500)).toBe(false);
  });

  it("falls through to apply when base or server timestamp is unknown", () => {
    expect(shouldApplyOnFlush(update(null), 1500)).toBe(true);
    expect(shouldApplyOnFlush(update(1000), null)).toBe(true);
  });

  it("guards a delete the same way", () => {
    const del = (base: number | null): EventScopedOp => ({ kind: "event.delete", id: "a", base });
    expect(shouldApplyOnFlush(del(1000), 900)).toBe(true);
    expect(shouldApplyOnFlush(del(1000), 1500)).toBe(false);
  });

  it("applies when the server's advance is OUR OWN flush's write (no false conflict)", () => {
    expect(shouldApplyOnFlush(update(1000), 1500, 1500)).toBe(true);
    // A stranger's write at a different timestamp still parks.
    expect(shouldApplyOnFlush(update(1000), 1600, 1500)).toBe(false);
    // Unknown own-write timestamp keeps the strict guard.
    expect(shouldApplyOnFlush(update(1000), 1500, null)).toBe(false);
    // Delete after our own flushed update must also pass.
    const del: EventScopedOp = { kind: "event.delete", id: "a", base: 1000 };
    expect(shouldApplyOnFlush(del, 1500, 1500)).toBe(true);
  });
});

describe("eventPatchApplied — idempotent event.update replay", () => {
  it("true when the server row already carries the exact patch", () => {
    expect(eventPatchApplied({ name: "A", venue: "V" }, { name: "A", venue: "V", other: 1 })).toBe(
      true
    );
  });

  it("false when any patched value differs or the row is missing", () => {
    expect(eventPatchApplied({ name: "A" }, { name: "B" })).toBe(false);
    expect(eventPatchApplied({ name: "A" }, null)).toBe(false);
    expect(eventPatchApplied({ name: "A" }, undefined)).toBe(false);
  });

  it("normalizes undefined→null and editor HH:MM vs server HH:MM:SS", () => {
    expect(eventPatchApplied({ notes: undefined }, { notes: null })).toBe(true);
    expect(eventPatchApplied({ show_start_time: "14:30" }, { show_start_time: "14:30:00" })).toBe(
      true
    );
    expect(eventPatchApplied({ show_start_time: "14:30" }, { show_start_time: "15:00:00" })).toBe(
      false
    );
  });

  it("compares nested values canonically (jsonb key reorder is still equal)", () => {
    expect(eventPatchApplied({ meta: { a: 1, b: 2 } }, { meta: { b: 2, a: 1 } })).toBe(true);
  });

  it("an empty patch is trivially applied", () => {
    expect(eventPatchApplied({}, { name: "X" })).toBe(true);
  });
});

describe("isUniqueViolation — 23505 detection for the snapshot replay retry", () => {
  it("matches the Postgres code and the message text", () => {
    expect(isUniqueViolation("23505", null)).toBe(true);
    expect(
      isUniqueViolation(null, 'duplicate key value violates unique constraint "one_photo"')
    ).toBe(true);
  });

  it("does not match other failures", () => {
    expect(isUniqueViolation("42501", "permission denied")).toBe(false);
    expect(isUniqueViolation(null, "Failed to fetch")).toBe(false);
    expect(isUniqueViolation(null, null)).toBe(false);
  });
});

describe("nextOpRev — queue-record rev bookkeeping (conditional flush delete)", () => {
  it("starts at 1 for a fresh record and bumps an existing rev", () => {
    expect(nextOpRev(undefined)).toBe(1);
    expect(nextOpRev(null)).toBe(1);
    expect(nextOpRev(3)).toBe(4);
  });
});

describe("planEnqueue — coalesce a new write into the queue (one op per event)", () => {
  const qCreate = (seq: number, id = "x"): MgmtOp => ({
    kind: "event.create",
    seq,
    id,
    values: { name: "A", venue: "V1" },
  });
  const qUpdate = (seq: number, id = "x", base: number | null = 1000): MgmtOp => ({
    kind: "event.update",
    seq,
    id,
    patch: { name: "B" },
    base,
  });

  it("appends when the queue holds nothing for this event", () => {
    const incoming: NewMgmtOp = { kind: "event.update", id: "x", patch: { name: "B" }, base: 1 };
    expect(planEnqueue([qUpdate(1, "other")], incoming)).toEqual({
      dropSeqs: [],
      replaceSeq: null,
      op: incoming,
    });
  });

  it("always appends a create (fresh uuid — can't collide)", () => {
    const incoming: NewMgmtOp = { kind: "event.create", id: "new", values: { name: "N" } };
    expect(planEnqueue([qCreate(1)], incoming)).toEqual({
      dropSeqs: [],
      replaceSeq: null,
      op: incoming,
    });
  });

  it("folds an update into a queued create's values", () => {
    const plan = planEnqueue([qCreate(1)], {
      kind: "event.update",
      id: "x",
      patch: { name: "B" },
      base: null,
    });
    expect(plan).toEqual({
      dropSeqs: [],
      replaceSeq: 1,
      op: { kind: "event.create", id: "x", values: { name: "B", venue: "V1" } },
    });
  });

  it("merges update-onto-update, keeping the ORIGINAL base (guard reference)", () => {
    const plan = planEnqueue([qUpdate(1, "x", 1000)], {
      kind: "event.update",
      id: "x",
      patch: { venue: "V2" },
      base: 2000, // later local timestamp must NOT displace the original base
    });
    expect(plan).toEqual({
      dropSeqs: [],
      replaceSeq: 1,
      op: { kind: "event.update", id: "x", patch: { name: "B", venue: "V2" }, base: 1000 },
    });
  });

  it("cancels out create→delete entirely (server never saw the row)", () => {
    const plan = planEnqueue([qCreate(1), qUpdate(2)], {
      kind: "event.delete",
      id: "x",
      base: null,
    });
    expect(plan).toEqual({ dropSeqs: [1, 2], replaceSeq: null, op: null });
  });

  it("lets a delete supersede a queued update", () => {
    const incoming: NewMgmtOp = { kind: "event.delete", id: "x", base: 5 };
    expect(planEnqueue([qUpdate(3)], incoming)).toEqual({
      dropSeqs: [3],
      replaceSeq: null,
      op: incoming,
    });
  });
});

describe("materializeEventRow — offline create renders like a server row", () => {
  it("fills DB defaults, keeps the queued values, stamps the client id", () => {
    const row = materializeEventRow(
      { id: "cid", values: { name: "งานใหม่", group_id: "g1", tenant_id: "t1" } },
      "2026-07-02T00:00:00.000Z"
    );
    expect(row.id).toBe("cid");
    expect(row.name).toBe("งานใหม่");
    expect(row.group_id).toBe("g1");
    expect(row.is_template).toBe(false);
    expect(row.is_practice).toBe(false);
    expect(row.status).toBe("draft");
    expect(row.created_at).toBe("2026-07-02T00:00:00.000Z");
    expect(row.last_run_seconds).toBeNull();
  });

  it("queued values win over the defaults", () => {
    const row = materializeEventRow(
      { id: "cid", values: { status: "confirmed" as never } },
      "2026-07-02T00:00:00.000Z"
    );
    expect(row.status).toBe("confirmed");
  });
});

describe("describeOp — Thai labels for chips/conflicts", () => {
  it("uses the event name when present", () => {
    expect(
      describeOp({ kind: "event.create", id: "abcd1234-x", values: { name: "งานปีใหม่" } })
    ).toBe("สร้าง“งานปีใหม่”");
    expect(
      describeOp({ kind: "event.update", id: "abcd1234-x", patch: { name: "งานปีใหม่" }, base: null })
    ).toBe("แก้ไข“งานปีใหม่”");
  });

  it("falls back to a short id when the op has no name", () => {
    expect(describeOp({ kind: "event.delete", id: "abcd1234-rest", base: null })).toBe(
      "ลบงาน #abcd1234"
    );
  });
});

describe("isQueueableWriteError — network failures queue, real rejections surface", () => {
  it("anything while navigator says offline is queueable", () => {
    expect(isQueueableWriteError("row-level security", false)).toBe(true);
    expect(isQueueableWriteError(null, false)).toBe(true);
  });

  it("fetch/network transport failures are queueable while 'online'", () => {
    expect(isQueueableWriteError("TypeError: Failed to fetch", true)).toBe(true);
    expect(isQueueableWriteError("fetch failed", true)).toBe(true);
    expect(isQueueableWriteError("NetworkError when attempting to fetch resource", true)).toBe(true);
    expect(isQueueableWriteError("net::ERR_INTERNET_DISCONNECTED", true)).toBe(true);
  });

  it("RLS / validation / constraint errors are NOT queueable", () => {
    expect(
      isQueueableWriteError('new row violates row-level security policy for table "events"', true)
    ).toBe(false);
    expect(isQueueableWriteError("duplicate key value violates unique constraint", true)).toBe(false);
    expect(isQueueableWriteError(null, true)).toBe(false);
  });
});

describe("newEventId", () => {
  it("mints distinct uuid-shaped ids", () => {
    const a = newEventId();
    const b = newEventId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Child-list snapshots (step 5)
// ---------------------------------------------------------------------------

function childOp(over: Partial<ChildListOp> = {}): ChildListOp {
  return {
    kind: "schedule.upsert",
    id: "ev1",
    tenantId: "t1",
    rows: [],
    base: null,
    ...over,
  };
}

describe("sanitizeChildRows — write-column projection + normalization", () => {
  it("projects to the write columns and turns undefined into null", () => {
    const rows = [
      { id: "a", tenant_id: "t", event_id: "e", kind: "other", sort_order: 1, junk: "x" },
    ];
    const out = sanitizeChildRows("schedule.upsert", rows) as Record<string, unknown>[];
    expect(out[0]).toEqual({
      id: "a",
      tenant_id: "t",
      event_id: "e",
      kind: "other",
      label: null,
      location: null,
      start_time: null,
      end_time: null,
      notes: null,
      sort_order: 1,
    });
    expect("junk" in out[0]).toBe(false);
  });

  it("normalizes editor HH:MM times to the server's HH:MM:SS", () => {
    const rows = [{ id: "a", start_time: "14:30", end_time: "15:00:00" }];
    const out = sanitizeChildRows("schedule.upsert", rows) as Record<string, unknown>[];
    expect(out[0].start_time).toBe("14:30:00");
    expect(out[0].end_time).toBe("15:00:00");
  });

  it("sorts lineup member ids (set semantics)", () => {
    expect(sanitizeChildRows("lineup.upsert", ["b", "a"])).toEqual(["a", "b"]);
  });
});

describe("fingerprintChildRows — canonical, order-independent", () => {
  it("is stable across row order and object key order", () => {
    const a = [
      { id: "r1", tenant_id: "t", event_id: "e", mic_number: 1, holder_name: "A", order_index: 1 },
      { id: "r2", tenant_id: "t", event_id: "e", mic_number: 2, holder_name: "B", order_index: 1 },
    ];
    const b = [
      { order_index: 1, holder_name: "B", mic_number: 2, event_id: "e", tenant_id: "t", id: "r2" },
      { order_index: 1, holder_name: "A", mic_number: 1, event_id: "e", tenant_id: "t", id: "r1" },
    ];
    expect(fingerprintChildRows("mic.upsert", a)).toBe(fingerprintChildRows("mic.upsert", b));
  });

  it("changes when any written field changes", () => {
    const a = [{ id: "r1", holder_name: "A" }];
    const b = [{ id: "r1", holder_name: "B" }];
    expect(fingerprintChildRows("mic.upsert", a)).not.toBe(fingerprintChildRows("mic.upsert", b));
  });

  it("sorts nested jsonb keys (mic_slots survives a jsonb round-trip)", () => {
    const a = [{ id: "r1", mic_slots: [{ mic: 1, member: "A" }] }];
    const b = [{ id: "r1", mic_slots: [{ member: "A", mic: 1 }] }];
    expect(fingerprintChildRows("setlist.upsert", a)).toBe(fingerprintChildRows("setlist.upsert", b));
  });
});

describe("childFlushDecision — online-wins guard without updated_at", () => {
  const baseRows = [{ id: "r1", holder_name: "A" }];
  const myRows = [{ id: "r1", holder_name: "B" }];

  it("applies when the server still matches the rows I edited against", () => {
    const op = childOp({
      kind: "mic.upsert",
      rows: sanitizeChildRows("mic.upsert", myRows),
      base: fingerprintChildRows("mic.upsert", baseRows),
    });
    expect(childFlushDecision(op, baseRows)).toBe("apply");
  });

  it("treats a server that already matches MY snapshot as already-applied (re-run safe)", () => {
    const op = childOp({
      kind: "mic.upsert",
      rows: sanitizeChildRows("mic.upsert", myRows),
      base: fingerprintChildRows("mic.upsert", baseRows),
    });
    expect(childFlushDecision(op, myRows)).toBe("already-applied");
  });

  it("parks a conflict when the server changed under me", () => {
    const op = childOp({
      kind: "mic.upsert",
      rows: sanitizeChildRows("mic.upsert", myRows),
      base: fingerprintChildRows("mic.upsert", baseRows),
    });
    expect(childFlushDecision(op, [{ id: "r1", holder_name: "C" }])).toBe("conflict");
  });

  it("applies best-effort when there is no base to compare", () => {
    const op = childOp({ kind: "mic.upsert", rows: myRows, base: null });
    expect(childFlushDecision(op, [{ id: "zzz", holder_name: "?" }])).toBe("apply");
  });
});

describe("planEnqueue — child snapshots coalesce per (event x table)", () => {
  it("replaces a queued snapshot of the same kind, keeping the ORIGINAL base", () => {
    const first: MgmtOp = { ...childOp({ base: "fp-original" }), seq: 3 };
    const plan = planEnqueue([first], childOp({ rows: ["newer"], base: "fp-newer" }));
    expect(plan.replaceSeq).toBe(3);
    expect(plan.dropSeqs).toEqual([]);
    expect(plan.op && (plan.op as ChildListOp).base).toBe("fp-original");
    expect(plan.op && (plan.op as ChildListOp).rows).toEqual(["newer"]);
  });

  it("keeps snapshots of DIFFERENT kinds or events separate", () => {
    const first: MgmtOp = { ...childOp({ kind: "setlist.upsert" }), seq: 1 };
    const other: MgmtOp = { ...childOp({ id: "ev2" }), seq: 2 };
    const plan = planEnqueue([first, other], childOp());
    expect(plan.replaceSeq).toBeNull();
    expect(plan.dropSeqs).toEqual([]);
  });

  it("an event.delete drops the event's queued child snapshots too", () => {
    const child: MgmtOp = { ...childOp(), seq: 2 };
    const upd: MgmtOp = { kind: "event.update", seq: 1, id: "ev1", patch: {}, base: null };
    const plan = planEnqueue([upd, child], { kind: "event.delete", id: "ev1", base: null });
    expect(plan.dropSeqs.sort()).toEqual([1, 2]);
    expect(plan.op?.kind).toBe("event.delete");
  });

  it("offline create + child edits + delete cancel out entirely", () => {
    const create: MgmtOp = { kind: "event.create", seq: 1, id: "ev1", values: {} };
    const child: MgmtOp = { ...childOp(), seq: 2 };
    const plan = planEnqueue([create, child], { kind: "event.delete", id: "ev1", base: null });
    expect(plan.dropSeqs.sort()).toEqual([1, 2]);
    expect(plan.op).toBeNull();
  });
});

describe("applyPending / applyPendingChildren — overlays", () => {
  it("applyPending ignores child snapshots (they never touch the events list)", () => {
    const rows = [{ id: "ev1" }];
    expect(applyPending(rows, [{ ...childOp(), seq: 1 }])).toEqual(rows);
  });

  it("applyPendingChildren replaces the right list for the right event, in seq order", () => {
    const bundle = {
      setlist: [{ id: "s1" }],
      schedule: [{ id: "c1" }],
      micMap: [{ id: "m1" }],
      lineup: ["mem1"],
    };
    const ops: MgmtOp[] = [
      { ...childOp({ kind: "schedule.upsert", rows: [{ id: "c2" }] }), seq: 2 },
      { ...childOp({ kind: "schedule.upsert", rows: [{ id: "c3" }] }), seq: 3 },
      { ...childOp({ kind: "lineup.upsert", rows: ["mem2"] }), seq: 4 },
      { ...childOp({ kind: "setlist.upsert", id: "OTHER", rows: [{ id: "sX" }] }), seq: 5 },
    ];
    const out = applyPendingChildren(bundle, ops, "ev1");
    expect(out.schedule).toEqual([{ id: "c3" }]); // latest snapshot wins
    expect(out.lineup).toEqual(["mem2"]);
    expect(out.setlist).toEqual([{ id: "s1" }]); // other event's op ignored
    expect(out.micMap).toEqual([{ id: "m1" }]);
  });

  it("fills a created_at fallback on overlaid mic rows (dropped from the projection)", () => {
    const bundle = { setlist: [], schedule: [], micMap: [], lineup: [] };
    const ops: MgmtOp[] = [{ ...childOp({ kind: "mic.upsert", rows: [{ id: "m2" }] }), seq: 1 }];
    const out = applyPendingChildren(bundle, ops, "ev1");
    expect((out.micMap as Record<string, unknown>[])[0].created_at).toBeTruthy();
  });
});

describe("describeOp — child snapshot labels", () => {
  it("uses the event name when known", () => {
    expect(describeOp(childOp({ kind: "setlist.upsert", eventName: "WARUDO" }))).toContain(
      "WARUDO"
    );
  });
  it("falls back to the event id snippet", () => {
    expect(describeOp(childOp({ id: "12345678-x" }))).toContain("12345678");
  });
});
