import { describe, expect, it } from "vitest";
import {
  type MgmtOp,
  applyPending,
  newEventId,
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

describe("newEventId", () => {
  it("mints distinct uuid-shaped ids", () => {
    const a = newEventId();
    const b = newEventId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});
