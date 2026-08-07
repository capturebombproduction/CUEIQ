// The festival running order — the one board a whole festival reads — and the six
// awaits that could hold it on a spinner.
//
// This file's try/catch already routed a FAILURE to served(cached()). A HANG never
// got there. isOffline() is false on a venue wifi that is JOINED but black-holed
// (navigator.onLine TRUE, TCP connects, nothing ever answers), so every await ran
// unbounded and คุมคิว Live sat on "โหลดคิวงานไม่สำเร็จ"… never, actually — it sat on
// nothing at all, with the running order already in localStorage.
//
// Every transition below is CAUSED by advancing fake timers. Nothing waits on
// wall-clock time, because the failure being pinned is precisely "a promise that
// never settles" and a test that waited for one would be the same hang.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { loadRunOrderBuild, loadRunOrderLive, RUN_ORDER_TIMEOUT_MS } from "./run-order";

// ── fixtures ──────────────────────────────────────────────────────────────────

const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const EVENT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const BAND_EVENT_ID = "eeeeeeee-0000-4000-8000-000000000002";
const GROUP_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const LIVE_RAW_KEY = `cueiq:cache:runlive:${EVENT_ID}`;
const BUILD_RAW_KEY = `cueiq:cache:runbuild:${EVENT_ID}`;

const FEST = { id: EVENT_ID, name: "A Lot Of Tone Fest", event_date: "2026-08-09" };

const groupNames = () => new Map([[GROUP_ID, "Seishin Kakumei"]]);

/** The board already on disk — what every fallback below must reach. */
const cachedLive = {
  name: "A Lot Of Tone Fest",
  date: "2026-08-09",
  seqs: [{ id: "q1", sort_order: 0, label: "วงแรก", offset_min: 0 }],
};
const cachedBuild = {
  name: "A Lot Of Tone Fest",
  date: "2026-08-09",
  seqs: [{ id: "q1", sort_order: 0, label: "วงแรก" }],
  bandEvents: [{ id: BAND_EVENT_ID, group_name: "Seishin Kakumei", stage_start: null, stage_end: null }],
};

function seedLiveCache(): string {
  const raw = JSON.stringify(cachedLive);
  window.localStorage.setItem(LIVE_RAW_KEY, raw);
  return raw;
}
function seedBuildCache(): string {
  const raw = JSON.stringify(cachedBuild);
  window.localStorage.setItem(BUILD_RAW_KEY, raw);
  return raw;
}

/** navigator.onLine is read-only in jsdom; isOffline() only looks at this one bit. */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setOnline(true);
  supa = makeSupabaseFake({ session: makeSession(), script: { events: ok([FEST]) } });
  h.supa = supa;
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

// ── loadRunOrderLive ──────────────────────────────────────────────────────────

describe("loadRunOrderLive — a read that never answers", () => {
  it("serves the cached board once RUN_ORDER_TIMEOUT_MS has passed", async () => {
    // The festival-name read. Unbounded, คุมคิว Live never rendered anything.
    const before = seedLiveCache();
    const held = supa.defer("events");

    const p = loadRunOrderLive(TENANT_ID, EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(held.taken).toBe(true);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
    expect(res.data.seqs).toHaveLength(1);
    expect(window.localStorage.getItem(LIVE_RAW_KEY)).toBe(before);
  });

  it("serves the cached board when the run_sequence read never answers", async () => {
    const before = seedLiveCache();
    supa.setTable("run_sequence", neverAnswers);

    const p = loadRunOrderLive(TENANT_ID, EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
    expect(window.localStorage.getItem(LIVE_RAW_KEY)).toBe(before);
  });

  it("keeps the cached board when an empty order cannot be proven to carry a token", async () => {
    // Replacing a live festival's board with "ยังไม่มีคิว" is the worst outcome
    // here, and hasLiveSession() runs over the same dead network.
    const before = seedLiveCache();
    supa.setTable("run_sequence", ok([]));
    supa.auth.hang("getSession");

    const p = loadRunOrderLive(TENANT_ID, EVENT_ID);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.data.seqs).toHaveLength(1);
    expect(window.localStorage.getItem(LIVE_RAW_KEY)).toBe(before);
  });

  it("never reports 'gone' when the row is missing and getSession() never answers", async () => {
    // "gone" navigates the show-caller off a live board. Only a read that
    // SUCCEEDED and found nothing may do that — a hang has proven nothing.
    seedLiveCache();
    supa.setTable("events", ok([]));
    supa.auth.hang("getSession");

    const p = loadRunOrderLive(TENANT_ID, EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
  });

  it("resolves to 'error', not a hang, when there is nothing cached", async () => {
    supa.setTable("events", neverAnswers);

    const p = loadRunOrderLive(TENANT_ID, EVENT_ID);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS);

    // "error" renders โหลดคิวงานไม่สำเร็จ + a retry. Rendering NOTHING is the bug.
    await expect(p).resolves.toEqual({ status: "error" });
  });
});

describe("loadRunOrderLive — the branches the bound joins", () => {
  it("returns and caches a successful read unchanged", async () => {
    seedLiveCache();
    supa.setScript({
      events: ok([FEST]),
      run_sequence: ok([
        { id: "q9", sort_order: 0, label: "วงเปิด" },
        { id: "q10", sort_order: 1, label: "วงปิด" },
      ]),
    });

    const res = await loadRunOrderLive(TENANT_ID, EVENT_ID);

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(false);
    expect(res.data.name).toBe("A Lot Of Tone Fest");
    expect(res.data.seqs).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(LIVE_RAW_KEY) ?? "null").seqs).toHaveLength(2);
  });

  it("still reports a genuine deletion as gone once the session is proven live", async () => {
    // Symmetry check: the bound has not turned "งานนี้ถูกลบ" into "keep the board".
    seedLiveCache();
    supa.setTable("events", ok([]));

    await expect(loadRunOrderLive(TENANT_ID, EVENT_ID)).resolves.toEqual({ status: "gone" });
  });

  it("serves the cache offline without issuing a request", async () => {
    seedLiveCache();
    setOnline(false);

    const res = await loadRunOrderLive(TENANT_ID, EVENT_ID);

    expect(res.status).toBe("ok");
    expect(supa.calls).toHaveLength(0);
  });
});

// ── loadRunOrderBuild — the same hazard, four more awaits ─────────────────────

describe("loadRunOrderBuild — a read that never answers", () => {
  it("serves the cached board when the festival-events read never answers", async () => {
    // The SECOND events read (the builder's band list), not the first: a queued
    // script answers the name lookup and then goes silent.
    const before = seedBuildCache();
    supa.setTable("events", [ok([FEST]), neverAnswers]);

    const p = loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());
    const state = watch(p);
    await settleMicrotasks();
    expect(supa.callsTo("events")).toHaveLength(2);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
    expect(window.localStorage.getItem(BUILD_RAW_KEY)).toBe(before);
  });

  it("serves the cached board when the schedule_items stage read never answers", async () => {
    const before = seedBuildCache();
    supa.setScript({
      events: [ok([FEST]), ok([{ id: BAND_EVENT_ID, group_id: GROUP_ID }])],
      schedule_items: neverAnswers,
    });

    const p = loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
    expect(window.localStorage.getItem(BUILD_RAW_KEY)).toBe(before);
  });

  it("serves the cached board when the run_sequence read never answers", async () => {
    const before = seedBuildCache();
    supa.setScript({
      events: [ok([FEST]), ok([{ id: BAND_EVENT_ID, group_id: GROUP_ID }])],
      schedule_items: ok([{ event_id: BAND_EVENT_ID, start_time: "19:00:00", end_time: "19:40:00" }]),
      run_sequence: neverAnswers,
    });

    const p = loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(true);
    expect(window.localStorage.getItem(BUILD_RAW_KEY)).toBe(before);
  });

  it("keeps the cached board when an empty order cannot be proven to carry a token", async () => {
    const before = seedBuildCache();
    supa.setScript({
      events: [ok([FEST]), ok([{ id: BAND_EVENT_ID, group_id: GROUP_ID }])],
      schedule_items: ok([]),
      run_sequence: ok([]),
    });
    supa.auth.hang("getSession");

    const p = loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RUN_ORDER_TIMEOUT_MS);
    const res = await p;

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.data.seqs).toHaveLength(1);
    expect(window.localStorage.getItem(BUILD_RAW_KEY)).toBe(before);
  });
});

describe("loadRunOrderBuild — the branches the bound joins", () => {
  it("returns and caches a successful read unchanged", async () => {
    seedBuildCache();
    supa.setScript({
      events: [ok([FEST]), ok([{ id: BAND_EVENT_ID, group_id: GROUP_ID }])],
      // A band may hold SEVERAL stage slots on one festival day — both must survive.
      schedule_items: ok([
        { event_id: BAND_EVENT_ID, start_time: "13:00:00", end_time: "13:40:00" },
        { event_id: BAND_EVENT_ID, start_time: "19:00:00", end_time: "19:40:00" },
      ]),
      run_sequence: ok([{ id: "q9", sort_order: 0, label: "วงเปิด" }]),
    });

    const res = await loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.fromCache).toBe(false);
    expect(res.data.name).toBe("A Lot Of Tone Fest");
    expect(res.data.seqs).toHaveLength(1);
    expect(res.data.bandEvents).toHaveLength(2);
    expect(res.data.bandEvents.map((b) => b.stage_start)).toEqual(["13:00:00", "19:00:00"]);
    expect(res.data.bandEvents[0].group_name).toBe("Seishin Kakumei");
    const stored = JSON.parse(window.localStorage.getItem(BUILD_RAW_KEY) ?? "null");
    expect(stored.bandEvents).toHaveLength(2);
  });

  it("skips the stage read entirely when the festival has no band events", async () => {
    // The `ids.length ? … : { data: [], error: null }` branch — the bound must not
    // have turned "nothing to ask about" into a failure.
    seedBuildCache();
    supa.setScript({
      events: [ok([FEST]), ok([])],
      run_sequence: ok([{ id: "q9", sort_order: 0, label: "วงเปิด" }]),
    });

    const res = await loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.data.bandEvents).toEqual([]);
    expect(supa.callsTo("schedule_items")).toHaveLength(0);
  });

  it("serves the cache offline without issuing a request", async () => {
    seedBuildCache();
    setOnline(false);

    const res = await loadRunOrderBuild(TENANT_ID, EVENT_ID, groupNames());

    expect(res.status).toBe("ok");
    expect(supa.calls).toHaveLength(0);
  });
});
