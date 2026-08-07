// คลังเพลง — the only door to the offline audio-upload queue — and the two awaits
// that could leave it waiting instead of falling back.
//
// fetchSongs already answers `null` for every read it cannot trust, and library.tsx
// serves readCachedSongs on null. But a read that never SETTLES never returns null
// either, so the fallback never ran: isOffline() is false on a venue wifi that is
// JOINED but black-holed (navigator.onLine TRUE, TCP connects, nothing ever
// answers), and the page waited with the catalogue already in localStorage.
//
// Every transition below is CAUSED by advancing fake timers. Nothing waits on
// wall-clock time, because the failure being pinned is precisely "a promise that
// never settles" and a test that waited for one would be the same hang.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  anonEmpty,
  fail,
  makeSession,
  makeSupabaseFake,
  ok,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import {
  fetchSongs,
  readCachedSongs,
  SONG_LIBRARY_TIMEOUT_MS,
  songsCacheKey,
  warmSongLibrary,
} from "./song-library";

// ── fixtures ──────────────────────────────────────────────────────────────────

const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP_A = "bbbbbbbb-0000-4000-8000-000000000001";
const GROUP_B = "bbbbbbbb-0000-4000-8000-000000000002";
const IDS = [GROUP_B, GROUP_A]; // deliberately unsorted — the key must not care

const RAW_KEY = `cueiq:cache:${songsCacheKey(TENANT_ID, IDS)}`;

const cachedSongs = [
  { id: "song-1", tenant_id: TENANT_ID, group_id: GROUP_A, title: "แสงสุดท้าย" },
];

function seedSongsCache(): string {
  const raw = JSON.stringify(cachedSongs);
  window.localStorage.setItem(RAW_KEY, raw);
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
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

// ── a read that never answers ─────────────────────────────────────────────────

describe("fetchSongs — a read that never answers", () => {
  it("returns null once SONG_LIBRARY_TIMEOUT_MS has passed, so the caller can fall back", async () => {
    const before = seedSongsCache();
    const held = supa.defer("songs");

    const p = fetchSongs(TENANT_ID, IDS);
    const state = watch(p);
    await settleMicrotasks();
    expect(held.taken).toBe(true);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SONG_LIBRARY_TIMEOUT_MS - 1);
    // If this is already true the bound is coming from somewhere else.
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    // null is the whole contract: it is what makes library.tsx serve the cache
    // instead of waiting. Never returning it is the bug.
    await expect(p).resolves.toBeNull();
    expect(readCachedSongs(TENANT_ID, IDS)).toHaveLength(1);
    expect(window.localStorage.getItem(RAW_KEY)).toBe(before);
  });

  it("returns null when an empty catalogue cannot be proven to carry a token", async () => {
    // The anon-RLS lie plus a black-holed getSession(): caching [] here would wipe
    // this device's only copy of the library, and the offline-upload door with it.
    const before = seedSongsCache();
    supa.setTable("songs", anonEmpty());
    supa.auth.hang("getSession");

    const p = fetchSongs(TENANT_ID, IDS);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SONG_LIBRARY_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(p).resolves.toBeNull();
    expect(window.localStorage.getItem(RAW_KEY)).toBe(before);
  });
});

// ── the branches the bound joins ──────────────────────────────────────────────

describe("fetchSongs — the branches the bound joins", () => {
  it("returns null on an errored read and leaves the cache untouched", async () => {
    const before = seedSongsCache();
    supa.setTable("songs", fail("Failed to fetch", 500));

    await expect(fetchSongs(TENANT_ID, IDS)).resolves.toBeNull();
    expect(window.localStorage.getItem(RAW_KEY)).toBe(before);
  });

  it("returns null offline without issuing a request", async () => {
    seedSongsCache();
    setOnline(false);

    await expect(fetchSongs(TENANT_ID, IDS)).resolves.toBeNull();
    expect(supa.calls).toHaveLength(0);
  });

  it("returns and caches a successful read unchanged", async () => {
    // The control: the race must be invisible on the happy path.
    seedSongsCache();
    const fresh = [
      { id: "song-9", tenant_id: TENANT_ID, group_id: GROUP_A, title: "ลาก่อน" },
      { id: "song-10", tenant_id: TENANT_ID, group_id: GROUP_B, title: "เพลงใหม่" },
    ];
    supa.setTable("songs", ok(fresh));

    const rows = await fetchSongs(TENANT_ID, IDS);

    expect(rows?.map((r) => r.id)).toEqual(["song-9", "song-10"]);
    const stored = JSON.parse(window.localStorage.getItem(RAW_KEY) ?? "null");
    expect(stored).toHaveLength(2);
    expect(stored[1].title).toBe("เพลงใหม่");
    // And it went out as the query the library actually needs.
    const call = supa.lastCall("songs", "select");
    expect(call?.eq).toMatchObject({ tenant_id: TENANT_ID });
    expect(call?.filters.some((f) => f.op === "in" && f.column === "group_id")).toBe(true);
  });

  it("caches a genuinely empty catalogue once the session is proven live", async () => {
    // Symmetry check for the bound above: a real empty answer still writes through,
    // so the timeout has not quietly turned "no songs yet" into "keep the old list".
    seedSongsCache();
    supa.setTable("songs", ok([]));

    await expect(fetchSongs(TENANT_ID, IDS)).resolves.toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(RAW_KEY) ?? "null")).toEqual([]);
  });

  it("answers [] with no request at all when the user has no bands", async () => {
    await expect(fetchSongs(TENANT_ID, [])).resolves.toEqual([]);
    expect(supa.calls).toHaveLength(0);
  });
});

// ── warmSongLibrary: the dashboard rides along, it must not be held up ────────

describe("warmSongLibrary — best-effort must also mean bounded", () => {
  it("resolves after the bound rather than hanging on the dashboard", async () => {
    // This runs from the dashboard's own effect on the way past. Unbounded, that
    // promise simply never settled on a black-holed venue wifi.
    supa.setTable("songs", neverAnswers);

    const p = warmSongLibrary(TENANT_ID, IDS);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SONG_LIBRARY_TIMEOUT_MS);
    await expect(p).resolves.toBeUndefined();
    // Nothing was cached — a timeout is not a result.
    expect(readCachedSongs(TENANT_ID, IDS)).toBeNull();
  });

  it("swallows a rejected read", async () => {
    supa.setTable("songs", () => Promise.reject(new Error("Failed to fetch")));

    await expect(warmSongLibrary(TENANT_ID, IDS)).resolves.toBeUndefined();
  });

  it("leaves the catalogue on disk on a successful warm", async () => {
    supa.setTable("songs", ok(cachedSongs));

    await warmSongLibrary(TENANT_ID, IDS);

    expect(readCachedSongs(TENANT_ID, IDS)).toHaveLength(1);
  });
});
