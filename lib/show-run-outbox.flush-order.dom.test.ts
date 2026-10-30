// A replay of the show-run queue vs a newer direct write of the same show (2026-10-30, hunt 11).
//
// flushOutbox had no in-flight guard and nothing ordered it against persistLastRun. On a slow
// link the replay of an OLD queued run time was still on the wire when the operator pressed
// ล้าง (or จบโชว์ again): the clear landed first, the old time after it, and the server kept
// the run the operator had just wiped - while persistLastRun had already deleted the queued
// op as "superseded", so nothing ever put it right. Now a write made during a pass is queued
// behind it (and lands after it), a pass leaves a show alone while its direct write is in
// flight, and one pass runs at a time.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { enqueue, flushOutbox, pendingCount, persistLastRun } from "@/lib/show-run-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

const macrotask = () => new Promise((r) => setTimeout(r, 0));
/** an op queued earlier than "now" (persistLastRun keeps one stamped in its own millisecond) */
async function queuedEarlier(seconds: number, at: number) {
  await enqueue({ kind: "event_last_run", eventId: "ev1", seconds, at });
  await new Promise((r) => setTimeout(r, 5));
}
async function drain() {
  for (let i = 0; i < 10; i++) await macrotask();
}

let supa: SupabaseFake;
let server: { last_run_seconds: number | null };
let writes: (number | null)[];
/** gate for the update that writes `slow` seconds: it hangs until released */
let slow: number | null = null;
let release: () => void = () => {};
/** resolves when the slow update has been SENT (it is on the wire) */
let onWire: Promise<void> = Promise.resolve();

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = { last_run_seconds: 999 };
  writes = [];
  slow = null;
  const gate = new Promise<void>((r) => (release = r));
  let sent: () => void = () => {};
  onWire = new Promise<void>((r) => (sent = r));
  supa.setTable("events", async (call: RecordedCall) => {
    if (call.verb === "update") {
      const v = (call.values as { last_run_seconds: number | null }).last_run_seconds;
      if (slow !== null && v === slow) {
        sent();
        await gate;
      }
      server.last_run_seconds = v;
      writes.push(v);
      return ok([{ id: "ev1" }]);
    }
    return ok({ id: "ev1" });
  });
});

describe("show-run queue · a replay never lands over a newer direct write", () => {
  it("ล้าง pressed while the replay of an older run time is on the wire: the server ends cleared", async () => {
    await queuedEarlier(754, 1_754_000_000_000);
    slow = 754;
    const flushing = flushOutbox(); // reconnect: the old time goes out, slowly
    await onWire;
    const outcome = persistLastRun("ev1", null, null); // the operator presses ล้าง
    await drain();
    release(); // the old replay finally lands
    await flushing;
    await drain();
    await flushOutbox(); // whatever pass is still due has run
    expect(server.last_run_seconds).toBeNull();
    expect(writes).toEqual([754, null]); // in the order they were made
    // said truthfully: not on the server yet when it returned - queued behind the replay
    expect(await outcome).toBe("queued");
    expect(await pendingCount()).toBe(0);
  });

  it("a newer จบโชว์ during the replay: the newer run time wins", async () => {
    await queuedEarlier(754, 1_754_000_000_000);
    slow = 754;
    const flushing = flushOutbox();
    await onWire;
    void persistLastRun("ev1", 1201, 1_754_100_000_000);
    await drain();
    release();
    await flushing;
    await drain();
    await flushOutbox();
    expect(server.last_run_seconds).toBe(1201);
  });

  it("a pass sends the value queued NOW, not the one its list read: a superseded time never goes out", async () => {
    await enqueue({ kind: "event_last_run", eventId: "ev0", seconds: 100, at: 1_753_000_000_000 }); // another show, first in line
    await queuedEarlier(754, 1_754_000_000_000);
    slow = 100;
    const flushing = flushOutbox();
    await onWire; // busy with the other show
    expect(await persistLastRun("ev1", null, null)).toBe("queued");
    release();
    await flushing;
    await drain();
    await flushOutbox();
    expect(writes).toEqual([100, null]);
  });

  it("no pass running: written at once and 'saved', as before - an older queued value is dropped", async () => {
    await queuedEarlier(754, 1_754_000_000_000);
    expect(await persistLastRun("ev1", 1201, 1_754_100_000_000)).toBe("saved");
    expect(server.last_run_seconds).toBe(1201);
    expect(await pendingCount()).toBe(0);
    await flushOutbox();
    expect(writes).toEqual([1201]); // the superseded 754 never goes out
  });

  it("a pass that starts while a direct write is on the wire leaves that show's op to it", async () => {
    await queuedEarlier(754, 1_754_000_000_000);
    slow = 1201; // the DIRECT write is the slow one now
    const direct = persistLastRun("ev1", 1201, 1_754_100_000_000);
    await onWire;
    await flushOutbox(); // 'online' fires meanwhile
    release();
    expect(await direct).toBe("saved");
    await flushOutbox();
    expect(server.last_run_seconds).toBe(1201);
    expect(writes).toEqual([1201]);
  });

  it("two calls of flushOutbox at once share one pass (each op written once)", async () => {
    await queuedEarlier(754, 1_754_000_000_000);
    const [a, b] = await Promise.all([flushOutbox(), flushOutbox()]);
    expect(a).toEqual(b);
    expect(writes).toEqual([754]);
    expect(a.flushed).toBe(1);
  });
});
