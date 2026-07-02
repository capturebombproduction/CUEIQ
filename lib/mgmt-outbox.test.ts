import { describe, expect, it } from "vitest";
import {
  type MgmtOp,
  type NewMgmtOp,
  applyPending,
  describeOp,
  isQueueableWriteError,
  materializeEventRow,
  newEventId,
  planEnqueue,
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
  const update = (base: number | null): MgmtOp => ({
    kind: "event.update",
    seq: 1,
    id: "a",
    patch: {},
    base,
  });

  it("always applies a create (brand-new row, no base)", () => {
    const create: MgmtOp = { kind: "event.create", seq: 1, id: "a", values: {} };
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
    const del = (base: number | null): MgmtOp => ({ kind: "event.delete", seq: 1, id: "a", base });
    expect(shouldApplyOnFlush(del(1000), 900)).toBe(true);
    expect(shouldApplyOnFlush(del(1000), 1500)).toBe(false);
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
