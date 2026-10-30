// Whose press is it? (2026-10-30, hunt 10)
//
// The running-order queue outlives a sign-out and carried no owner, so the next account
// to sign in on the same machine replayed the last one's offline presses under its own
// session. One that may not write run_sequence (run_sequence_update = can_approve) but
// can read it (is_tenant_member) matched 0 rows and found the row unchanged - parked as
// "someone else drove the board", whose only way out is ทิ้ง: the presses never landed,
// even after their owner signed back in. Each op now carries the account that queued it
// (read synchronously at enqueue), and a flush under another account leaves the whole
// press untouched: not sent, not prechecked, not parked, not rebased.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import {
  enqueueRunSeq,
  flushRunSeqOutbox,
  listRunSeqOps,
  mergeOp,
  type RunSeqOp,
} from "@/lib/run-order-outbox";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

type Row = Record<string, unknown> & { id: string };

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

function signIn(userId: string | null) {
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const k = window.localStorage.key(i);
    if (k && /^sb-.+-auth-token$/.test(k)) window.localStorage.removeItem(k);
  }
  if (userId) {
    window.localStorage.setItem(
      "sb-testref-auth-token",
      JSON.stringify({ access_token: "t", refresh_token: "r", user: { id: userId } })
    );
  }
}

/** run_sequence honouring the update's eq/is filters (the compare-and-swap). `canWrite`
 *  false = the signed-in account may read but not write (RLS: 0 rows, no error). */
function serverTable(rows: Row[], canWrite = () => true) {
  const matches = (r: Row, call: RecordedCall) =>
    call.filters.every((f) =>
      f.op === "eq"
        ? r[f.column] === f.value
        : f.op === "is"
          ? r[f.column] == null
          : f.op === "in"
            ? (f.value as unknown[]).includes(r[f.column])
            : true
    );
  return (call: RecordedCall) => {
    if (call.verb === "update") {
      if (!canWrite()) return ok([]);
      const hit = rows.filter((r) => matches(r, call));
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    const hit = rows.filter((r) => matches(r, call)).map((r) => ({ ...r }));
    return ok(call.terminal === "maybeSingle" ? (hit[0] ?? null) : hit);
  };
}

const row = (id: string, status: string): Row => ({
  id,
  status,
  actual_start: null,
  actual_end: null,
  offset_min: null,
  buffer_seconds: 0,
  planned_start: null,
});

const T1 = "2026-10-31T10:40:00.000Z";

/** "จบ + ต่อไป": the live act → done, the next → live - one press, two rows. */
async function pressEndAndNext(endId: string, nextId: string, pressId: string) {
  await enqueueRunSeq({
    rowId: endId,
    festival: "Ichiban",
    patch: { status: "done", actual_end: T1 },
    expect: { status: "live" },
    label: "จบ",
    queuedAt: Date.now(),
    presses: [pressId],
  });
  await enqueueRunSeq({
    rowId: nextId,
    festival: "Ichiban",
    patch: { status: "live", actual_start: T1 },
    expect: { status: "pending" },
    label: "เริ่ม",
    queuedAt: Date.now(),
    presses: [pressId],
  });
}

let supa: SupabaseFake;
let server: Row[];
let bMayWrite = false;
beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  signIn(null);
  server = [row("r1", "live"), row("r2", "pending"), row("r3", "live"), row("r4", "pending")];
  bMayWrite = false;
  supa = makeSupabaseFake({ session: makeSession({ user: { id: B } as never }) });
  h.supa = supa;
  const me = () => window.localStorage.getItem("sb-testref-auth-token") ?? "";
  supa.setTable("run_sequence", serverTable(server, () => !me().includes(B) || bMayWrite));
});
afterEach(() => signIn(null));

describe("another account's presses wait for it", () => {
  it("a press queued by A is left exactly as it was when B flushes - not parked", async () => {
    signIn(A);
    await pressEndAndNext("r1", "r2", "p-A");
    const before = await listRunSeqOps();
    signIn(B); // A signed out offline; B (reads the board, may not write it) signs in
    await flushRunSeqOutbox();
    const after = await listRunSeqOps();
    expect(after.some((o) => o.conflict)).toBe(false);
    expect(after).toEqual(before);
    expect(supa.callsTo("run_sequence")).toHaveLength(0); // not even prechecked
  });

  it("and lands whole once A signs in again", async () => {
    signIn(A);
    await pressEndAndNext("r1", "r2", "p-A");
    signIn(B);
    await flushRunSeqOutbox();

    signIn(A);
    supa.auth.setSession(makeSession({ user: { id: A } as never }));
    const r = await flushRunSeqOutbox();
    expect(r).toEqual({ flushed: 2, conflicts: 0, remaining: 0 });
    expect(server.find((x) => x.id === "r1")?.status).toBe("done");
    expect(server.find((x) => x.id === "r2")?.status).toBe("live");
  });

  it("B's own press beside it still lands, in its own order", async () => {
    signIn(A);
    await pressEndAndNext("r1", "r2", "p-A");
    signIn(B);
    bMayWrite = true; // an approver this time: B drives another stage's board
    await pressEndAndNext("r3", "r4", "p-B");
    const r = await flushRunSeqOutbox();
    expect(r.flushed).toBe(2);
    expect(server.find((x) => x.id === "r3")?.status).toBe("done");
    expect(server.find((x) => x.id === "r4")?.status).toBe("live");
    // A's untouched, B's gone
    const left = await listRunSeqOps();
    expect(left.map((o) => o.rowId).sort()).toEqual(["r1", "r2"]);
    expect(left.every((o) => !o.conflict && o.owner === A)).toBe(true);
    // the ending row went first, as groupRunSeqPresses orders a unit
    const updates = supa.callsTo("run_sequence", "update").map((c) => c.eq.id);
    expect(updates).toEqual(["r3", "r4"]);
  });
});

describe("the same account: exactly as before", () => {
  it("its own press lands whole", async () => {
    signIn(B);
    bMayWrite = true;
    await pressEndAndNext("r1", "r2", "p-B");
    expect((await listRunSeqOps()).every((o) => o.owner === B)).toBe(true);
    const r = await flushRunSeqOutbox();
    expect(r).toEqual({ flushed: 2, conflicts: 0, remaining: 0 });
  });

  it("its own press on a board that moved still parks (a real conflict)", async () => {
    signIn(B);
    bMayWrite = true;
    await pressEndAndNext("r1", "r2", "p-B");
    server.find((x) => x.id === "r2")!.status = "live"; // another device started it
    await flushRunSeqOutbox();
    expect((await listRunSeqOps()).every((o) => o.conflict)).toBe(true);
  });

  it("a press queued with nobody readable in storage has no owner and replays for whoever is in", async () => {
    signIn(null);
    await pressEndAndNext("r1", "r2", "p-old");
    expect((await listRunSeqOps()).every((o) => o.owner === undefined)).toBe(true);
    signIn(B);
    bMayWrite = true;
    expect((await flushRunSeqOutbox()).flushed).toBe(2);
  });
});

describe("mergeOp and the owner", () => {
  const base = (over: Partial<RunSeqOp>): RunSeqOp => ({
    rowId: "r1",
    festival: "f",
    patch: { status: "live" },
    expect: { status: "pending" },
    label: "x",
    queuedAt: 1,
    ...over,
  });

  it("keeps the owner when the same account presses again", () => {
    const m = mergeOp(base({ owner: A, rev: 1 }), base({ owner: A, patch: { offset_min: 2 } }));
    expect(m.owner).toBe(A);
  });

  it("a press by another account on the same row folds in with no owner (replays as before)", () => {
    const m = mergeOp(base({ owner: A, rev: 1 }), base({ owner: B, patch: { offset_min: 2 } }));
    expect(m.owner).toBeUndefined();
    expect(m.patch).toEqual({ status: "live", offset_min: 2 });
    expect(m.expect).toEqual({ status: "pending" });
  });

  it("an older record with no owner plus a stamped press: no owner", () => {
    expect(mergeOp(base({ rev: 1 }), base({ owner: B })).owner).toBeUndefined();
  });

  it("a press replacing a parked op takes the new press's owner", () => {
    expect(mergeOp(base({ owner: A, conflict: true, rev: 3 }), base({ owner: B })).owner).toBe(B);
  });
});
