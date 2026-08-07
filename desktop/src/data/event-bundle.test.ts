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
// Every transition below is CAUSED by advancing fake timers. Nothing waits on
// wall-clock time, because the failure being pinned is precisely "a promise that
// never settles" and a test that waited for one would be the same hang.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

// The offline management outbox is IndexedDB and is not what these tests are
// about; an empty queue is the "nothing pending" case every assertion below wants
// (withPendingOverlay then returns the bundle untouched).
vi.mock("~/data/mgmt-outbox", () => ({
  pendingMgmtOps: vi.fn(() => Promise.resolve([])),
  listMgmtConflicts: vi.fn(() => Promise.resolve([])),
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
}));

import {
  EVENT_BUNDLE_TIMEOUT_MS,
  isEventBundleCached,
  loadEventBundle,
  warmEventBundle,
} from "./event-bundle";

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

let supa: SupabaseFake;

beforeEach(() => {
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

  it("serves the cache when the tenant_members read never answers", async () => {
    // The membership await sat after the try/catch AND had no bound — the show
    // screen parked here with the whole bundle already on disk.
    const before = seedBundleCache();
    supa.setTable("tenant_members", neverAnswers);

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const bundle = await p;

    expect(bundle?.event.name).toBe("cached show");
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });

  it("serves the cache when ONE of the six child reads never answers", async () => {
    // Promise.all cannot settle without every leg, so a single silent child read
    // is enough to hold the entire show hostage.
    const before = seedBundleCache();
    supa.setTable("setlist_items", neverAnswers);

    const p = loadEventBundle(EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS - 1);
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

    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS - 1);
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
