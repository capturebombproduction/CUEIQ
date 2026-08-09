// The show's own data, and the four awaits that could hold it hostage.
//
// loadEventBundle short-circuits on isOffline() and then read the network with no
// bound at all. isOffline() only catches the network the OS knows is gone; the
// venue case is the other one — wifi JOINED, navigator.onLine TRUE, TCP connects,
// nothing ever answers. So the show screen sat on its spinner for ever while THIS
// EVENT'S run sheet, setlist and mic map sat in localStorage, written for exactly
// this moment. And two of those awaits (tenant_members, the six child reads) were
// outside any try/catch, so a REJECTION escaped loadEventBundle entirely instead of
// falling through to that cache.
//
// Then the bound itself became the bug. The child batch is a Promise.all of seven
// selects and it was given the SINGLE-READ budget, so 8s covered all seven together
// — and a congested-but-working venue hotspot that answered in 9s was written off as
// dead. With no cached bundle that resolved to a bare null, and the show screen said
// "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง": a working network, an existing show, and an
// operator told at load-in that it was deleted. Hence the two things asserted below
// that are new — the batch has its own larger budget, and "we could not reach it" is
// a different answer from "it is gone".
//
// Every transition below is CAUSED by advancing fake timers. Nothing waits on
// wall-clock time, because the failure being pinned is precisely "a promise that
// never settles" and a test that waited for one would be the same hang.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MgmtOp } from "@/lib/mgmt-outbox";
import {
  anonEmpty,
  makeSession,
  makeSupabaseFake,
  ok,
  type ScriptFn,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, ops: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

// The offline management outbox is IndexedDB and is not what most of these tests
// are about; `h.ops` is reset to an EMPTY queue in beforeEach, which is the
// "nothing pending" case every assertion below wants (withPendingOverlay then
// returns the bundle untouched).
//
// It is a settable box rather than a fixed `[]` for one reason, and it is the
// reason the delete-vs-unreachable pair further down could not be written before:
// with `pendingMgmtOps` hard-wired to `[]`, withPendingOverlay's queued-delete
// branch was unreachable from this file, so the one answer that must NOT be
// "unreachable" had no test at all.
vi.mock("~/data/mgmt-outbox", () => ({
  pendingMgmtOps: vi.fn(() => Promise.resolve(h.ops)),
  listMgmtConflicts: vi.fn(() => Promise.resolve([])),
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
}));

import {
  EVENT_BUNDLE_BATCH_TIMEOUT_MS,
  EVENT_BUNDLE_SESSION_TIMEOUT_MS,
  EVENT_BUNDLE_TIMEOUT_MS,
  isEventBundleCached,
  loadEventBundle,
  loadEventBundleStatus,
  warmEventBundle,
} from "./event-bundle";
// The dashboard's list loader lives next door and is the OTHER half of the same
// finding: its timeouts stack with the bundle's on the way to a venue screen. Its
// secondary session probe is asserted here rather than in a file of its own so the
// two budgets are read — and kept honest — side by side.
import {
  EVENTS_LIST_SESSION_TIMEOUT_MS,
  EVENTS_LIST_TIMEOUT_MS,
  loadEventsList,
} from "./events-list";

// ── fixtures ──────────────────────────────────────────────────────────────────

const EVENT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "eeeeeeee-0000-4000-8000-000000000002";
const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const rawKey = (id: string) => `cueiq:cache:event:${id}`;

const eventRow = (id = EVENT_ID, name = "fresh show") => ({
  id,
  name,
  tenant_id: TENANT_ID,
  group_id: GROUP_ID,
  event_date: "2026-08-09",
  groups: { id: GROUP_ID, name: "Seishin Kakumei" },
});

/** The bundle already on disk — the thing every fallback below must reach. */
const cachedBundle = (id = EVENT_ID) => ({
  event: {
    id,
    name: "cached show",
    tenant_id: TENANT_ID,
    group_id: GROUP_ID,
    group: { id: GROUP_ID, name: "Seishin Kakumei" },
  },
  schedule: [{ id: "s1", event_id: id, kind: "stage", start_time: "19:00:00" }],
  setlist: [{ id: "sl1", event_id: id, sort_order: 0, song_id: "song-1" }],
  micMap: [{ id: "m1", event_id: id, mic_number: 1 }],
  members: [{ id: "mem1", group_id: GROUP_ID, name: "Vo" }],
  songs: [{ id: "song-1", group_id: GROUP_ID, title: "แสงสุดท้าย" }],
  lineup: ["mem1"],
  role: "member",
});

/** Writes the cache and hands back the exact bytes, for byte-for-byte comparison. */
function seedBundleCache(id = EVENT_ID): string {
  const raw = JSON.stringify(cachedBundle(id));
  window.localStorage.setItem(rawKey(id), raw);
  return raw;
}

/** navigator.onLine is read-only in jsdom; isOffline() only looks at this one bit. */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

/** Push every already-scheduled microtask chain through without moving the clock,
 *  so the loader reaches the await we are about to time out. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Resolution as an observable fact: `settled` must still be false one tick before
 *  the deadline, or the constant under test is not the thing doing the work. */
function watch<T>(p: Promise<T>): { readonly settled: boolean } {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    }
  );
  return state;
}

/** A scripted answer that never arrives — the black-holed venue wifi. */
const neverAnswers = () => new Promise<never>(() => {});

/** A leg that answers LATE but does answer — the congested venue hotspot at
 *  load-in, which is a working network and must be treated as one. */
const answersAfter =
  (ms: number, result: ScriptResult): ScriptFn =>
  () =>
    new Promise<ScriptResult>((resolve) => setTimeout(() => resolve(result), ms));

/** A delete this DEVICE queued while offline — the one local answer that needs
 *  neither the server nor the cache. `base` is the epoch-ms the row was read at and
 *  `seq` the per-device counter; neither matters to the overlay, which filters on
 *  `id` and branches on `kind`. */
const queuedDelete = (id = EVENT_ID): MgmtOp => ({
  kind: "event.delete",
  id,
  base: Date.parse("2026-08-09T10:00:00.000Z"),
  seq: 1,
});

let supa: SupabaseFake;

beforeEach(() => {
  h.ops = [];
  // Only the timer functions the loader uses. fake-indexeddb and supabase-js both
  // schedule on setImmediate/queueMicrotask, and faking those turns an unrelated
  // hang into the thing the test appears to be proving.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setOnline(true);
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { events: ok([eventRow()]) },
  });
  h.supa = supa;
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

// ── a read that never answers ─────────────────────────────────────────────────

describe("loadEventBundle — a read that never answers", () => {
  it("serves the cached bundle once EVENT_BUNDLE_TIMEOUT_MS has passed", async () => {
    const before = seedBundleCache();
    const held = supa.defer("events");

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(held.taken).toBe(true);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS - 1);
    // If this is already true the bound is coming from somewhere else.
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const bundle = await p;

    expect(bundle?.event.name).toBe("cached show");
    expect(bundle?.setlist).toHaveLength(1);
    // A timeout is not a result: it must never overwrite what it fell back to.
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });

  it("serves the cache when the tenant_members leg never answers", async () => {
    // The membership await sat after the try/catch AND had no bound — the show
    // screen parked here with the whole bundle already on disk. It now rides in
    // the child batch, so the batch budget is what bounds it.
    const before = seedBundleCache();
    supa.setTable("tenant_members", neverAnswers);

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_BATCH_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const bundle = await p;

    expect(bundle?.event.name).toBe("cached show");
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });

  it("serves the cache when ONE leg of the child batch never answers", async () => {
    // Promise.all cannot settle without every leg, so a single silent child read
    // is enough to hold the entire show hostage.
    const before = seedBundleCache();
    supa.setTable("setlist_items", neverAnswers);

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    // The batch is SEVEN reads and gets a budget that says so: at the single-read
    // budget it must still be waiting, not writing the show off.
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_BATCH_TIMEOUT_MS - EVENT_BUNDLE_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const bundle = await p;

    expect(bundle?.setlist).toHaveLength(1);
    expect(bundle?.event.name).toBe("cached show");
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });

  it("does not call a show deleted when getSession() never answers", async () => {
    // The row came back empty. That is "deleted" ONLY if we can prove the request
    // carried our token — and hasLiveSession() runs over the same dead network.
    const before = seedBundleCache();
    supa.setTable("events", ok([]));
    supa.auth.hang("getSession");

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    // A SECONDARY probe on a network that has already answered once: it gets its
    // own short budget rather than a fresh full read budget, because these bounds
    // stack and the operator is already waiting.
    expect(EVENT_BUNDLE_SESSION_TIMEOUT_MS).toBeLessThan(EVENT_BUNDLE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_SESSION_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const bundle = await p;

    // null here is "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง" on the screen — for a show
    // whose bundle is sitting right there.
    expect(bundle).not.toBeNull();
    expect(bundle?.event.name).toBe("cached show");
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });
});

// ── the congested hotspot: slow is not dead ───────────────────────────────────

describe("loadEventBundle — a batch that is slow but WORKING", () => {
  /** Load-in: twenty phones on the venue hotspot. Seven reads, two of them a whole
   *  band's members and songs, land together at 9s. Under the single-read budget
   *  that was a timeout — and on a laptop that had never opened this show there was
   *  no cache to fall back to, so the Ar was told the show did not exist. */
  const slowBatch = (ms: number) => {
    supa.setScript({
      events: ok([eventRow()]),
      tenant_members: ok([{ role: "artist_manager" }]),
      schedule_items: ok([{ id: "s9", event_id: EVENT_ID, kind: "stage" }]),
      setlist_items: answersAfter(
        ms,
        ok([
          { id: "sl9", event_id: EVENT_ID, sort_order: 0 },
          { id: "sl10", event_id: EVENT_ID, sort_order: 1 },
        ])
      ),
      mic_assignments: ok([{ id: "m9", event_id: EVENT_ID, mic_number: 2 }]),
      members: answersAfter(ms, ok([{ id: "mem9", group_id: GROUP_ID, name: "Gt" }])),
      songs: answersAfter(ms, ok([{ id: "song-9", group_id: GROUP_ID, title: "ลาก่อน" }])),
      event_members: ok([{ member_id: "mem9" }]),
    });
  };

  it("still delivers the show when the batch answers after the SINGLE-read budget", async () => {
    slowBatch(9000);

    const p = loadEventBundleStatus(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();

    // 8s in: the old bound had already given up here and, with nothing cached,
    // handed the page a null it rendered as "ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง".
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    const { bundle, unreachable } = await p;

    expect(unreachable).toBe(false);
    expect(bundle?.event.name).toBe("fresh show");
    expect(bundle?.setlist).toHaveLength(2);
    expect(bundle?.songs).toHaveLength(1);
    // FRESH data, and written through — the next cold boot at this venue opens it.
    const stored = JSON.parse(window.localStorage.getItem(rawKey(EVENT_ID)) ?? "null");
    expect(stored.setlist).toHaveLength(2);
    expect(stored.songs[0].title).toBe("ลาก่อน");
  });

  it("does not let a slow batch resurrect a stale cache over fresh rows", async () => {
    // The other way the old bound hurt: a device that HAD an old bundle showed it
    // instead of the setlist that changed at soundcheck.
    seedBundleCache();
    slowBatch(9000);

    const p = loadEventBundleStatus(EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(9000);
    const { bundle } = await p;

    expect(bundle?.event.name).toBe("fresh show");
    expect(bundle?.setlist).toHaveLength(2);
  });
});

// ── "we could not reach it" is not "it is gone" ───────────────────────────────

describe("loadEventBundleStatus — the two answers that used to be one null", () => {
  it("flags a timed-out load with nothing cached as unreachable", async () => {
    // No cache: this laptop has never opened this show. The page must offer ลองใหม่,
    // not tell the operator the show was deleted.
    supa.setTable("events", neverAnswers);

    const p = loadEventBundleStatus(EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);

    await expect(p).resolves.toEqual({ bundle: null, unreachable: true });
  });

  it("flags a batch timeout with nothing cached as unreachable", async () => {
    supa.setTable("songs", neverAnswers);

    const p = loadEventBundleStatus(EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_BATCH_TIMEOUT_MS);

    await expect(p).resolves.toEqual({ bundle: null, unreachable: true });
  });

  it("flags a rejected read with nothing cached as unreachable", async () => {
    supa.setTable("events", () => Promise.reject(new Error("Failed to fetch")));

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: true,
    });
  });

  it("flags offline-with-nothing-cached as unreachable, not as a missing show", async () => {
    setOnline(false);

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: true,
    });
  });

  it("does NOT flag a proven deletion — that screen must stay a dead end", async () => {
    // The symmetry that keeps the retry screen honest: a show the server says is
    // gone, with a session we can prove, is gone. Offering ลองใหม่ for it forever
    // would be its own lie.
    supa.setTable("events", ok([]));

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: false,
    });
  });

  it("does NOT flag a healthy load", async () => {
    const { bundle, unreachable } = await loadEventBundleStatus(EVENT_ID);

    expect(unreachable).toBe(false);
    expect(bundle?.event.name).toBe("fresh show");
  });
});

// ── the third answer: a delete THIS DEVICE queued ─────────────────────────────
//
// Once "we could not reach it" was split off from "it is gone", the offline branch
// marked EVERY empty answer unreachable — and that is a lie for exactly one case.
// An operator deletes a show at the venue with no signal (the delete is queued in
// the management outbox, ⭐#1 step 2), then taps back into it. The server was never
// asked and the cache was deliberately emptied by the overlay, so the loader hands
// back a null with `unreachable: true` — and pages/event.tsx offers ลองใหม่ for a
// deletion this device performed, plus "ไม่มีสำเนาในเครื่องนี้" for a show it has a
// copy of. Retrying can never change that answer, because there is no answer to get.
//
// Both directions are pinned here, because the distinction collapses just as
// completely if it is fixed the other way (mark every null "gone" and a black-holed
// hotspot becomes a false obituary — the finding the split was made for). The two
// scenarios differ by ONE thing: whether a delete for THIS event is queued.
describe("loadEventBundleStatus — a queued local delete is not an unreachable server", () => {
  it("reports 'this is gone' for an event deleted offline and reopened offline", async () => {
    setOnline(false);
    // The device still HOLDS the bundle — this is the reopen, not a cold laptop.
    // Serving it would be worse than the retry button: the show would open as if
    // the delete never happened.
    seedBundleCache();
    h.ops = [queuedDelete()];

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: false,
    });
    // The delete is a local answer: it must cost no request even if the OS is wrong
    // about being offline a moment later.
    expect(supa.calls).toHaveLength(0);
  });

  it("still reports unreachable when the queued delete belongs to ANOTHER event", async () => {
    // The mirror, kept one variable away from the test above so neither can be made
    // to pass by widening the other: same offline, same empty cache for THIS id, a
    // queue that is not empty — and the answer flips straight back to "retry".
    setOnline(false);
    h.ops = [queuedDelete(OTHER_EVENT_ID)];

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: true,
    });
  });

  it("still reports unreachable offline with an EMPTY queue and no cache", async () => {
    // The plainest form of the same mirror: nothing queued, nothing on disk. This is
    // the venue laptop that never opened tonight's show, and it must keep its ลองใหม่.
    setOnline(false);

    await expect(loadEventBundleStatus(EVENT_ID)).resolves.toEqual({
      bundle: null,
      unreachable: true,
    });
  });

  it("reports 'gone' for a queued delete even when the read never answers", async () => {
    // navigator.onLine is the network the OS knows about; the venue case is the
    // black-holed AP that reports itself online. The verdict must not depend on
    // which of the two the device is in — the delete is local either way.
    seedBundleCache();
    h.ops = [queuedDelete()];
    supa.setTable("events", neverAnswers);

    const p = loadEventBundleStatus(EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);

    await expect(p).resolves.toEqual({ bundle: null, unreachable: false });
  });
});

// ── a read that REJECTS: the same cached path ─────────────────────────────────

describe("loadEventBundle — a read that rejects", () => {
  it("serves the cache when the events read rejects", async () => {
    seedBundleCache();
    supa.setTable("events", () => Promise.reject(new Error("Failed to fetch")));

    const bundle = await loadEventBundle(EVENT_ID);

    expect(bundle?.event.name).toBe("cached show");
  });

  it("serves the cache when the tenant_members read rejects", async () => {
    // This one used to ESCAPE: the await was outside the try/catch, so the whole
    // loadEventBundle promise rejected instead of falling through to the cache.
    seedBundleCache();
    supa.setTable("tenant_members", () => Promise.reject(new Error("Failed to fetch")));

    const bundle = await loadEventBundle(EVENT_ID);

    expect(bundle?.event.name).toBe("cached show");
    expect(bundle?.micMap).toHaveLength(1);
  });

  it("serves the cache when a child read rejects", async () => {
    // Same escape, one await later: Promise.all rejects if any leg does.
    seedBundleCache();
    supa.setTable("event_members", () => Promise.reject(new Error("Failed to fetch")));

    const bundle = await loadEventBundle(EVENT_ID);

    expect(bundle?.event.name).toBe("cached show");
    expect(bundle?.lineup).toEqual(["mem1"]);
  });

  it("still resolves to null when there is nothing cached to serve", async () => {
    // No cache and no answer is a real "we have nothing" — but it must be a
    // RESOLVED null the caller can render, not a rejection or a hang.
    supa.setTable("tenant_members", () => Promise.reject(new Error("Failed to fetch")));

    await expect(loadEventBundle(EVENT_ID)).resolves.toBeNull();
  });
});

// ── the control: a healthy load is unchanged ──────────────────────────────────

describe("loadEventBundle — the happy path the bound must be invisible on", () => {
  it("returns the server bundle and writes it through to the cache", async () => {
    seedBundleCache();
    supa.setScript({
      events: ok([eventRow()]),
      tenant_members: ok([{ role: "admin" }]),
      schedule_items: ok([{ id: "s9", event_id: EVENT_ID, kind: "stage" }]),
      setlist_items: ok([
        { id: "sl9", event_id: EVENT_ID, sort_order: 0 },
        { id: "sl10", event_id: EVENT_ID, sort_order: 1 },
      ]),
      mic_assignments: ok([{ id: "m9", event_id: EVENT_ID, mic_number: 2 }]),
      members: ok([{ id: "mem9", group_id: GROUP_ID, name: "Gt" }]),
      songs: ok([{ id: "song-9", group_id: GROUP_ID, title: "ลาก่อน" }]),
      event_members: ok([{ member_id: "mem9" }]),
    });

    const bundle = await loadEventBundle(EVENT_ID);

    expect(bundle?.event.name).toBe("fresh show");
    expect(bundle?.event.group?.name).toBe("Seishin Kakumei");
    expect(bundle?.role).toBe("admin");
    expect(bundle?.setlist).toHaveLength(2);
    expect(bundle?.lineup).toEqual(["mem9"]);

    const stored = JSON.parse(window.localStorage.getItem(rawKey(EVENT_ID)) ?? "null");
    expect(stored.event.name).toBe("fresh show");
    expect(stored.setlist).toHaveLength(2);
    expect(stored.songs[0].title).toBe("ลาก่อน");
  });

  it("still reports a genuine deletion as gone once the session is proven live", async () => {
    // Symmetry check for the bound above: a real deletion must still read as one,
    // so the timeout has not quietly turned "งานนี้ถูกลบ" into "keep the old copy".
    seedBundleCache();
    supa.setTable("events", ok([]));

    await expect(loadEventBundle(EVENT_ID)).resolves.toBeNull();
  });

  it("serves the cache offline without issuing a request", async () => {
    seedBundleCache();
    setOnline(false);

    const bundle = await loadEventBundle(EVENT_ID);

    expect(bundle?.event.name).toBe("cached show");
    expect(supa.calls).toHaveLength(0);
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });
});

// ── warmEventBundle: the bulk prepare must not be stalled by one show ─────────

describe("warmEventBundle — one hung event must not stall the prepare run", () => {
  it("finishes the rest of the loop after the hung event times out", async () => {
    // This is the dashboard's เตรียมทุกงาน loop: a sequential `await` per event.
    // Unbounded, the FIRST unreachable show froze the whole run — the run whose
    // entire job is to make this device venue-ready before the wifi is cut.
    supa.setScript({
      events: [
        neverAnswers, // the first event never answers
        ok([eventRow(OTHER_EVENT_ID, "the show that must still land")]),
      ],
    });

    const order: string[] = [];
    const run = (async () => {
      for (const id of [EVENT_ID, OTHER_EVENT_ID]) {
        const cached = await warmEventBundle(id);
        order.push(`${id}:${cached}`);
      }
    })();
    const state = watch(run);

    await settleMicrotasks();
    expect(state.settled).toBe(false);
    // The second event has not even been asked for yet — that is the stall.
    expect(supa.callsTo("events")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);
    await run;

    expect(order).toEqual([`${EVENT_ID}:false`, `${OTHER_EVENT_ID}:true`]);
    expect(isEventBundleCached(EVENT_ID)).toBe(false);
    expect(isEventBundleCached(OTHER_EVENT_ID)).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(rawKey(OTHER_EVENT_ID)) ?? "null");
    expect(stored.event.name).toBe("the show that must still land");
  });

  it("reports false rather than throwing when the read rejects", async () => {
    supa.setTable("tenant_members", () => Promise.reject(new Error("Failed to fetch")));

    await expect(warmEventBundle(EVENT_ID)).resolves.toBe(false);
  });
});

// ── the other half: bounds that STACK on the way to a screen ──────────────────

describe("loadEventsList — the second bound the dashboard pays", () => {
  const listKey = `cueiq:cache:events:${TENANT_ID}:${GROUP_ID}`;
  const cachedList = [
    { id: EVENT_ID, name: "cached show", tenant_id: TENANT_ID, group_id: GROUP_ID, groups: null },
  ];

  it("gives the session probe its own short budget, not a second full read budget", async () => {
    // Reaching here on a black-holed network has already cost workspace.ts's
    // 5s + 8s + 8s and this loader's own 8s. A fresh 8s for a session probe pushed
    // the wait past half a minute — long past the point an operator force-quits and
    // never sees the cached list that was on disk the whole time.
    expect(EVENTS_LIST_SESSION_TIMEOUT_MS).toBeLessThan(EVENTS_LIST_TIMEOUT_MS);
    window.localStorage.setItem(listKey, JSON.stringify(cachedList));
    supa.setTable("events", anonEmpty());
    supa.auth.hang("getSession");

    const p = loadEventsList(TENANT_ID, [GROUP_ID]);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENTS_LIST_SESSION_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const rows = await p;

    // Still the cache, not a blank dashboard: an unprovable empty is not an empty.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("cached show");
  });

  it("still caches a genuinely empty list once the session is proven live", async () => {
    // The shortened probe must not have turned "this user really has no events"
    // into a permanent cache-only dashboard.
    supa.setTable("events", ok([]));

    await expect(loadEventsList(TENANT_ID, [GROUP_ID])).resolves.toEqual([]);
    expect(window.localStorage.getItem(listKey)).toBe("[]");
  });

  it("still returns fresh rows on a slow-but-working list read", async () => {
    supa.setTable(
      "events",
      answersAfter(
        EVENTS_LIST_TIMEOUT_MS - 1000,
        ok([{ id: EVENT_ID, name: "fresh show", tenant_id: TENANT_ID, group_id: GROUP_ID }])
      )
    );

    const p = loadEventsList(TENANT_ID, [GROUP_ID]);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(EVENTS_LIST_TIMEOUT_MS - 1000);
    const rows = await p;

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("fresh show");
    const stored = JSON.parse(window.localStorage.getItem(listKey) ?? "null");
    expect(stored[0].name).toBe("fresh show");
  });
});
