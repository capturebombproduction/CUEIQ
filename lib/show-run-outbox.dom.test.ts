// The queue that holds a whole night's run time.
//
// Everything in this file is about ONE asymmetry: replaying a queued op costs a
// round trip, and dropping one costs the only copy of a number the operator watched
// all night. So the module may retry forever, but it may only DELETE an op when it
// can prove the write is unrepeatable — and the ways it can be fooled into thinking
// that (an anon reply, a probe that failed, an event that exists only as a queued
// offline create on this very device) are exactly the cases below.
//
// `.dom.test.ts` on purpose: the queue is IndexedDB. Run in the node project every
// function would take its "storage unavailable" branch and the file would assert
// the fallback while proving nothing about the queue.
//
// The jsdom setup already imports fake-indexeddb; this line is a no-op there and
// keeps the file runnable on its own.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import {
  anonEmpty,
  fail,
  makeSession,
  makeSupabaseFake,
  offline,
  ok,
  type RecordedCall,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import {
  enqueue,
  flushOutbox,
  pendingCount,
  persistLastRun,
  SHOW_RUN_SAVE_EVENT,
  type ShowRunOp,
  type ShowRunSaveOutcome,
} from "@/lib/show-run-outbox";
// The chip is in this file rather than one of its own because it is the only
// consumer of pendingCount() — and the whole point of the null it now returns is
// what gets DRAWN for it. A module test that stops at the return value would have
// passed just as happily while the chip still rendered a confident zero.
import { LiveStatusStrip } from "@/components/event/live-status-strip";

// The other half of the harness note above: the desktop event-cache bridge lives on
// `window`, and the module treats "no window" as "no bridge" (correct on the web,
// where an eventId can never be one the server has not been told about yet). The
// node run has no window, so give it one — otherwise the two bridge tests below
// would pass by taking a branch that has nothing to do with what they assert.
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

const AT = 1_754_000_000_000; // epoch ms — the moment จบโชว์ was pressed
const AT_ISO = new Date(AT).toISOString();

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function op(eventId: string, seconds: number | null = 754, at: number | null = AT): ShowRunOp {
  return { kind: "event_last_run", eventId, seconds, at };
}

let supa: SupabaseFake;

/** The events table serves BOTH the replayed update and the "is the row gone?"
 *  probe, so a script has to answer by verb. Defaults: the update lands, and the
 *  probe (only issued when the module decides to ask) says the row is gone. */
function scriptEvents(opts: {
  update?: ScriptResult | ((call: RecordedCall) => ScriptResult);
  probe?: ScriptResult | (() => ScriptResult);
} = {}) {
  supa.setTable("events", (call) => {
    if (call.verb === "update") {
      const u = opts.update ?? ok([{ id: call.eq.id }]);
      return typeof u === "function" ? u(call) : u;
    }
    const p = opts.probe ?? ok([]);
    return typeof p === "function" ? p() : p;
  });
}

const updates = () => supa.callsTo("events", "update");
const probes = () => supa.callsTo("events", "select");

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

afterEach(() => {
  delete (window as unknown as { cueiqEventCache?: unknown }).cueiqEventCache;
});

describe("enqueue", () => {
  it("keys by (kind, eventId), so re-queuing the same datum updates it in place", async () => {
    await enqueue(op("ev1", 100));
    await enqueue(op("ev1", 754));
    expect(await pendingCount()).toBe(1);

    scriptEvents();
    await flushOutbox();
    // last value wins — correct for a last-run time, which is not a delta
    expect(updates()[0].values).toEqual({ last_run_seconds: 754, last_run_at: AT_ISO });
  });

  it("queues different events independently", async () => {
    await enqueue(op("ev1"));
    await enqueue(op("ev2"));
    expect(await pendingCount()).toBe(2);
  });

  // Every read/write opens its own connection and closes it again, so this is the
  // only thing that makes the queue worth having: the values are on disk, not in a
  // module variable that a reload or an app restart takes with it.
  it("survives the database being closed and reopened, values intact", async () => {
    await enqueue(op("ev1", 754));
    scriptEvents({ update: offline() });
    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });

    // a later session, a fresh client, the network back
    supa = makeSupabaseFake({ session: makeSession() });
    h.supa = supa;
    scriptEvents();

    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(updates()[0].values).toEqual({ last_run_seconds: 754, last_run_at: AT_ISO });
  });
});

describe("flushOutbox", () => {
  it("replays a queued write and clears it from the queue", async () => {
    await enqueue(op("ev1", 754));
    scriptEvents({ update: ok([{ id: "ev1" }]) });

    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(await pendingCount()).toBe(0);

    const [call] = updates();
    expect(call.eq).toEqual({ id: "ev1" });
    expect(call.values).toEqual({ last_run_seconds: 754, last_run_at: AT_ISO });
    // Load-bearing: without .select() the reply carries no rows and a 204 sent as
    // anon is indistinguishable from a successful write.
    expect(call.selectAfterWrite).toBe(true);
  });

  it("replays a cleared run time as nulls, not as a skipped field", async () => {
    await enqueue(op("ev1", null, null));
    scriptEvents();

    await flushOutbox();
    expect(updates()[0].values).toEqual({ last_run_seconds: null, last_run_at: null });
  });

  it("an empty queue is a no-op that touches no network at all", async () => {
    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 0 });
    expect(supa.calls).toHaveLength(0);
  });

  it("a second flush after a successful one re-sends nothing", async () => {
    await enqueue(op("ev1"));
    scriptEvents();
    await flushOutbox();

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 0 });
    expect(updates()).toHaveLength(1);
  });

  it("still offline: the op is kept and reported as remaining", async () => {
    await enqueue(op("ev1"));
    scriptEvents({ update: offline() });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
    expect(await pendingCount()).toBe(1);
  });

  // ─── the reason this module exists ──────────────────────────────────────────
  // A replay sent as ANON (expired token, refresh failed — the normal state in the
  // first minute after a venue reconnect) comes back 204 / error:null. Reading that
  // as success and deleting the op destroys the only copy of the night's run time.
  it("matched no row with no live session: KEEP it, and do not even ask whether the event is gone", async () => {
    supa.auth.setSession(null);
    await enqueue(op("ev1"));
    scriptEvents({ update: anonEmpty() });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
    expect(await pendingCount()).toBe(1);
    // "Is the row gone?" asked as anon would answer "yes, gone" for every row in
    // the database. The session check has to come first, and this proves it does.
    expect(probes()).toHaveLength(0);
  });

  it("matched no row with a live session and the event really deleted: drop it", async () => {
    await enqueue(op("ev1"));
    scriptEvents({ update: anonEmpty(), probe: ok([]) });

    // dropped, not flushed — there is nothing left that a retry could ever land on
    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 0 });
    expect(await pendingCount()).toBe(0);
    expect(probes()).toHaveLength(1);
    expect(probes()[0].eq).toEqual({ id: "ev1" });
  });

  it("matched no row but the probe failed: 'couldn't tell' is not 'it's gone'", async () => {
    await enqueue(op("ev1"));
    scriptEvents({ update: anonEmpty(), probe: fail("permission denied", 403) });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
  });

  it("matched no row and the probe never answered: still kept", async () => {
    await enqueue(op("ev1"));
    scriptEvents({
      update: anonEmpty(),
      probe: () => {
        throw new TypeError("Failed to fetch");
      },
    });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
  });

  // The desktop lets a whole show run on an event that exists only as a queued
  // offline `event.create`. "No such row" there means "not created YET" — dropping
  // the run time on that basis would lose the night's work on a technicality.
  it("an event still waiting to be created on this device is not 'gone'", async () => {
    const hasPendingOp = vi.fn(async () => true);
    (window as unknown as { cueiqEventCache: unknown }).cueiqEventCache = { hasPendingOp };

    await enqueue(op("local-ev"));
    scriptEvents({ update: anonEmpty(), probe: ok([]) });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
    expect(hasPendingOp).toHaveBeenCalledWith("local-ev");
    // The bridge is CONSULTED, not merely present: had the probe been issued anyway
    // its "no such row" would have dropped the op regardless of the answer.
    expect(probes()).toHaveLength(0);
  });

  it("the bridge saying no lets the probe decide as usual", async () => {
    (window as unknown as { cueiqEventCache: unknown }).cueiqEventCache = {
      hasPendingOp: vi.fn(async () => false),
    };

    await enqueue(op("ev1"));
    scriptEvents({ update: anonEmpty(), probe: ok([]) });

    expect(await flushOutbox()).toEqual({ flushed: 0, remaining: 0 });
    expect(probes()).toHaveLength(1);
  });

  // Ops are keyed per event and carry no information about each other, so one that
  // cannot land must not sit at the front of the queue jamming everything behind it.
  // ("event_last_run:ev-bad" sorts before "event_last_run:ev-good", so the failing
  // op really is first out of the cursor.)
  it("one op that cannot land does not hold up the others", async () => {
    await enqueue(op("ev-bad", 111));
    await enqueue(op("ev-good", 222));
    scriptEvents({
      update: (call) => (call.eq.id === "ev-bad" ? offline() : ok([{ id: call.eq.id }])),
    });

    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 1 });

    // and the survivor still holds its own value, not the failed op's
    scriptEvents();
    await flushOutbox();
    const last = updates().at(-1)!;
    expect(last.eq).toEqual({ id: "ev-bad" });
    expect(last.values).toEqual({ last_run_seconds: 111, last_run_at: AT_ISO });
  });
});

describe("persistLastRun", () => {
  it("writes straight through when online and queues nothing", async () => {
    scriptEvents({ update: ok([{ id: "ev1" }]) });

    await persistLastRun("ev1", 754, AT);

    expect(updates()).toHaveLength(1);
    expect(updates()[0].eq).toEqual({ id: "ev1" });
    expect(updates()[0].values).toEqual({ last_run_seconds: 754, last_run_at: AT_ISO });
    expect(updates()[0].selectAfterWrite).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it("clears the saved time with explicit nulls", async () => {
    scriptEvents();
    await persistLastRun("ev1", null, null);
    expect(updates()[0].values).toEqual({ last_run_seconds: null, last_run_at: null });
  });

  it("queues when the request never left the device", async () => {
    scriptEvents({ update: offline() });

    await persistLastRun("ev1", 754, AT);
    expect(await pendingCount()).toBe(1);
  });

  it("queues when the request rejects outright", async () => {
    supa.setTable("events", () => {
      throw new TypeError("Failed to fetch");
    });

    await persistLastRun("ev1", 754, AT);
    expect(await pendingCount()).toBe(1);
  });

  // The same anon hole as the replay path, at the point where จบโชว์ is pressed:
  // 204 with error:null and no row touched. Treating it as saved would report a
  // save that never happened AND queue nothing to retry it — the run time simply
  // ceases to exist.
  it("a no-error reply that touched no row is NOT a save — it queues", async () => {
    scriptEvents({ update: anonEmpty() });

    await persistLastRun("ev1", 754, AT);
    expect(await pendingCount()).toBe(1);

    // and what was queued is what the operator saw, replayed verbatim once signed in
    supa = makeSupabaseFake({ session: makeSession() });
    h.supa = supa;
    scriptEvents();
    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(updates()[0].values).toEqual({ last_run_seconds: 754, last_run_at: AT_ISO });
  });

  // Show-run is the "offline wins" conflict zone, so even a server refusal is kept
  // rather than discarded; flushOutbox is what eventually decides it is unrepeatable.
  it("a server refusal is queued too, not dropped on the floor", async () => {
    scriptEvents({ update: fail("permission denied", 403) });

    await persistLastRun("ev1", 754, AT);
    expect(await pendingCount()).toBe(1);
  });
});

// ─── a storage failure must not wear the same face as "nothing to sync" ───────
// This is the repo's own "a failed read is not a zero count" (lib/read-guard.ts)
// applied to the ONE store whose contents cannot be recreated: the last copy of a
// run time produced offline. Both directions are pinned, because either one alone
// degenerates — a pendingCount that always answered null would be just as useless
// as one that always answered 0, and a chip that always warned would be ignored by
// the second night.
const killStorage = () => {
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
};

describe("pendingCount: an unreadable queue is not a zero", () => {
  const real = globalThis.indexedDB;
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
  });

  it("answers null when the queue cannot be read at all", async () => {
    await enqueue(op("ev1"));
    expect(await pendingCount()).toBe(1);

    killStorage();
    // NOT 0. Zero is a claim ("everything is uploaded, you may close the laptop")
    // and we have no basis for it — the op above is still in there somewhere.
    expect(await pendingCount()).toBeNull();
  });

  it("...but an EMPTY queue really is zero, and stays zero", async () => {
    // The other direction, and the one a nervous fix breaks: nothing queued is a
    // fact we DO know, and it must keep reading as the plain number 0.
    expect(await pendingCount()).toBe(0);

    await enqueue(op("ev1"));
    scriptEvents();
    await flushOutbox();
    expect(await pendingCount()).toBe(0);
  });
});

describe("persistLastRun: 'could neither send nor store' is its own answer", () => {
  const real = globalThis.indexedDB;
  const outcomes: (ShowRunSaveOutcome | undefined)[] = [];
  const listen = (e: Event) =>
    outcomes.push((e as CustomEvent<{ outcome?: ShowRunSaveOutcome }>).detail?.outcome);

  beforeEach(() => {
    outcomes.length = 0;
    window.addEventListener(SHOW_RUN_SAVE_EVENT, listen);
  });
  afterEach(() => {
    window.removeEventListener(SHOW_RUN_SAVE_EVENT, listen);
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
  });

  it("says 'saved' when the write landed, and does not cry wolf", async () => {
    scriptEvents({ update: ok([{ id: "ev1" }]) });

    await expect(persistLastRun("ev1", 754, AT)).resolves.toBe("saved");
    expect(outcomes).toEqual(["saved"]);
    expect(await pendingCount()).toBe(0);
  });

  it("says 'queued' when it could not be sent but IS on disk", async () => {
    scriptEvents({ update: offline() });

    await expect(persistLastRun("ev1", 754, AT)).resolves.toBe("queued");
    expect(outcomes).toEqual(["queued"]);
    expect(await pendingCount()).toBe(1);
  });

  it("says 'lost' — loudly — when it was NEITHER sent nor stored", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    scriptEvents({ update: offline() });
    killStorage();

    // It used to resolve undefined here, exactly like the queued case above, so
    // จบโชว์ toasted "บันทึกแล้ว" over a number that had nowhere left to live.
    await expect(persistLastRun("ev1", 754, AT)).resolves.toBe("lost");
    // Both callers are fire-and-forget, so the window event is the half that
    // actually reaches a human. It is not optional decoration.
    expect(outcomes).toEqual(["lost"]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

// ─── and what the operator actually SEES ──────────────────────────────────────
// round 10's most common defect was a fix that could not execute: a value nothing
// read, a branch nothing reached. These three mount the real chip.
describe("LiveStatusStrip renders the difference", () => {
  const real = globalThis.indexedDB;
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
  });

  const mount = () =>
    render(
      createElement(LiveStatusStrip, {
        eventId: "ev1",
        isController: true,
        soundOutput: true,
      })
    );

  /** Let the mount's own queue read settle, then flush React. Ours is issued
   *  after the component's, so by the time it resolves the component's has too. */
  const settle = () => act(async () => void (await pendingCount()));

  it("says nothing at all when the queue is genuinely empty", async () => {
    mount();
    await settle();

    // the strip IS on screen — the absences below are silence, not a failed render
    expect(screen.getByText("ออนไลน์")).toBeInTheDocument();
    expect(screen.queryByText(/รอซิงค์/)).toBeNull();
    expect(screen.queryByText(/เช็คคิวซิงค์ไม่ได้/)).toBeNull();
  });

  it("warns instead of showing a confident nothing when the queue is unreadable", async () => {
    killStorage();
    mount();

    expect(await screen.findByText(/เช็คคิวซิงค์ไม่ได้/)).toBeInTheDocument();
    // and it must not also claim a count it does not have
    expect(screen.queryByText(/รอซิงค์/)).toBeNull();
  });

  it("raises a run-time-lost warning from the module's own event, and drops it when a later save lands", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mount();
    await settle();
    expect(screen.queryByText(/ยังไม่ได้บันทึกเวลาโชว์/)).toBeNull();

    // จบโชว์ with no network and no storage — fire-and-forget, exactly as
    // live-mode.tsx calls it.
    scriptEvents({ update: offline() });
    killStorage();
    await act(async () => void (await persistLastRun("ev1", 754, AT)));
    expect(screen.getByText(/ยังไม่ได้บันทึกเวลาโชว์/)).toBeInTheDocument();

    // The operator presses it again once the wifi is back. The warning has to go,
    // or it becomes wallpaper and the next real one is invisible.
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
    scriptEvents({ update: ok([{ id: "ev1" }]) });
    await act(async () => void (await persistLastRun("ev1", 754, AT)));
    expect(screen.queryByText(/ยังไม่ได้บันทึกเวลาโชว์/)).toBeNull();
    logged.mockRestore();
  });
});
