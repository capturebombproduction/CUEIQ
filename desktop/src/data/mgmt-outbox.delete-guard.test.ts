import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeSession,
  makeSupabaseFake,
  ok,
  type RecordedCall,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";

// The queued DELETE is the one op in this file with nothing to fall back on.
// `event.update` can be re-derived from the form; a delete that is recorded as
// SYNCED is simply forgotten — the event stays alive online, no conflict is
// parked, and no screen anywhere says the venue's intent was dropped. That is
// exactly what `if (!res.error) return "applied"` did on the 204-with-zero-rows
// an RLS-filtered (anon) request produces in the minute after a reconnect.
//
// These tests trace from the real entry point (enqueue → flushMgmtOutbox) to the
// guard, in both directions: 0 rows must PARK, 1 row must still apply. A test
// that only pinned "never applies" would pass against a delete that was broken
// outright.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtOps,
  resolveMgmtConflict,
} from "./mgmt-outbox";

const EVENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

/** What the online-wins guard read returns just before the delete goes out. */
const SERVER_ROW = {
  id: EVENT_ID,
  name: "Seishin Kakumei @ test",
  status: "approved",
  updated_at: "2026-08-01T10:00:00.000Z",
};

let supa: SupabaseFake;

/** The guard read answers with the row; the DELETE answers however the test says. */
function scriptDelete(onDelete: (call: RecordedCall) => ScriptResult) {
  supa.setScript({
    events: (call) => (call.verb === "delete" ? onDelete(call) : ok([SERVER_ROW])),
  });
}

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  // fake-indexeddb persists for the whole file — start every test from an empty
  // queue AND an empty conflicts store.
  await clearMgmtOutbox();
});

async function queueDelete() {
  await enqueueMgmtOp({ kind: "event.delete", id: EVENT_ID, base: null });
}

describe("flushMgmtOutbox — event.delete that removed no row", () => {
  it("parks the op instead of recording it as synced", async () => {
    scriptDelete(() => ok([])); // 204-with-zero-rows: RLS matched nothing
    await queueDelete();

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 0, parked: 1 });
    // The intent survives: out of the queue, into the conflicts panel — never gone.
    expect(await pendingMgmtOps()).toHaveLength(0);
    const conflicts = await listMgmtConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rec.op.kind).toBe("event.delete");
    expect(conflicts[0].rec.reason).toBeTruthy();
  });

  it("asked the server for the deleted rows back", async () => {
    // The guard above is unreachable without this — a delete with no .select()
    // resolves data:null, wroteNothing(null) is false, and the branch is dead code.
    scriptDelete(() => ok([]));
    await queueDelete();
    await flushMgmtOutbox();

    const del = supa.lastCall("events", "delete");
    expect(del?.selectAfterWrite).toBe(true);
    expect(del?.eq).toMatchObject({ id: EVENT_ID });
  });

  it("still applies (and clears the op) when the server returns the deleted row", async () => {
    scriptDelete(() => ok([{ id: EVENT_ID }]));
    await queueDelete();

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect(await pendingMgmtOps()).toHaveLength(0);
    expect(await listMgmtConflicts()).toHaveLength(0);
  });

  it("keeps the op QUEUED when the session died between the guard read and the write", async () => {
    // The whole reason 0 rows is ambiguous: it is also what an anon request looks
    // like. Parking on that verdict would tell the user to resolve a conflict the
    // server never actually declared, so the guard re-proves the session and a
    // failure there must leave the queue untouched for the next reconnect.
    scriptDelete(() => {
      supa.auth.setSession(null);
      return ok([]);
    });
    await queueDelete();

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 0, parked: 0, remaining: 1 });
    expect(await pendingMgmtOps()).toHaveLength(1);
    expect(await listMgmtConflicts()).toHaveLength(0);
  });

  it("does not reach the network at all with no session", async () => {
    supa.auth.setSession(null);
    scriptDelete(() => ok([{ id: EVENT_ID }]));
    await queueDelete();

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 0, parked: 0, remaining: 1 });
    expect(supa.callsTo("events")).toHaveLength(0);
    expect(await pendingMgmtOps()).toHaveLength(1);
  });
});

describe("resolveMgmtConflict('mine') — event.delete that removed no row", () => {
  /** Park one the honest way: a real flush that came back with 0 rows. */
  async function parkOne(): Promise<number> {
    scriptDelete(() => ok([]));
    await queueDelete();
    await flushMgmtOutbox();
    const conflicts = await listMgmtConflicts();
    expect(conflicts).toHaveLength(1);
    return conflicts[0].key;
  }

  it("keeps the conflict parked when the force-write still removes nothing", async () => {
    const key = await parkOne();
    supa.query.clearCalls();
    scriptDelete(() => ok([]));

    const res = await resolveMgmtConflict(key, "mine");

    // Falling through here would DELETE the conflict record — the queued delete
    // gone for good while the event is still live online.
    expect(res.ok).toBe(false);
    expect(res.message).toBeTruthy();
    expect(await listMgmtConflicts()).toHaveLength(1);
    expect(supa.lastCall("events", "delete")?.selectAfterWrite).toBe(true);
  });

  it("clears the conflict when the force-write really removes the row", async () => {
    const key = await parkOne();
    supa.query.clearCalls();
    scriptDelete(() => ok([{ id: EVENT_ID }]));

    const res = await resolveMgmtConflict(key, "mine");

    expect(res.ok).toBe(true);
    expect(await listMgmtConflicts()).toHaveLength(0);
  });
});
