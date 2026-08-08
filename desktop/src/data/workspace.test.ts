// The two loaders that stand between a cold desktop boot and a usable screen.
//
// Both had the SAME shape of bug, and it is not "slow" — it is never. A venue wifi
// that is JOINED but black-holed leaves navigator.onLine TRUE, lets TCP connect and
// then answers nothing at all. isOffline() is false, so neither loader took its
// offline branch, and neither await had a bound of its own — so the Shell sat on
// "กำลังโหลด…" and the dashboard on "กำลังโหลดงาน…" for ever, with the workspace,
// the events list and every cached master sitting on disk two feet away. ลองใหม่
// started the identical unbounded wait again.
//
// Every transition below is CAUSED by advancing fake timers. Nothing here waits on
// wall-clock time, because the failure being pinned is precisely "a promise that
// never settles" and a test that waits for one would be the same hang.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeSession,
  makeSupabaseFake,
  fail,
  ok,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

// The offline management outbox is IndexedDB and is not what these tests are
// about; an empty queue is the "nothing pending" case every assertion below wants.
vi.mock("~/data/mgmt-outbox", () => ({
  pendingMgmtOps: vi.fn(() => Promise.resolve([])),
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
}));

import { loadWorkspace, WORKSPACE_AUTH_TIMEOUT_MS, WORKSPACE_READ_TIMEOUT_MS } from "./workspace";
import {
  EVENTS_LIST_SESSION_TIMEOUT_MS,
  EVENTS_LIST_TIMEOUT_MS,
  loadEventsList,
} from "./events-list";

// ── fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const AUTH_KEY = "sb-kewyqqxohckurwuepucv-auth-token";
const WS_RAW_KEY = "cueiq:cache:workspace";
const VIEWABLE = [GROUP_ID, "bbbbbbbb-0000-4000-8000-000000000002"];
const EVENTS_RAW_KEY = `cueiq:cache:events:${TENANT_ID}:${[...VIEWABLE].sort().join(",")}`;

/** The RAW persisted supabase session — what getStoredSessionUser() reads. Expiry
 *  is irrelevant on purpose: a cold boot hours later is always in this state. */
function seedStoredSession(userId = USER_ID): void {
  window.localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      access_token: "expired.jwt.value",
      refresh_token: "r3fr3sh",
      expires_at: 1,
      user: { id: userId, email: "seishin-mem@cueiq.local" },
    })
  );
}

const cachedWorkspace = (userId = USER_ID) => ({
  user: { id: userId, email: "seishin-mem@cueiq.local", name: "Seishin" },
  membership: { tenant_id: TENANT_ID, role: "member" },
  tenant: { id: TENANT_ID, name: "A Lot Of Tone" },
  groups: [{ id: GROUP_ID, name: "Seishin Kakumei" }],
  groupRoles: [{ group_id: GROUP_ID, role: "member" }],
  perms: { tenantRole: "member", groupRoles: [{ group_id: GROUP_ID, role: "member" }] },
});

/** Writes the cache and hands back the exact bytes, for byte-for-byte comparison. */
function seedWorkspaceCache(userId = USER_ID): string {
  const raw = JSON.stringify(cachedWorkspace(userId));
  window.localStorage.setItem(WS_RAW_KEY, raw);
  return raw;
}

const cachedEvents = [
  { id: "eeeeeeee-0000-4000-8000-000000000001", name: "cached show", groups: null },
];

function seedEventsCache(): string {
  const raw = JSON.stringify(cachedEvents);
  window.localStorage.setItem(EVENTS_RAW_KEY, raw);
  return raw;
}

/** navigator.onLine is read-only in jsdom; isOffline() only looks at this one bit. */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

/** Push every already-scheduled microtask chain through without moving the clock,
 *  so the loader reaches the await we are about to time out. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
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

let supa: SupabaseFake;

beforeEach(() => {
  // Only the timer functions the loaders use. fake-indexeddb and supabase-js both
  // schedule on setImmediate/queueMicrotask, and faking those turns an unrelated
  // hang into the thing the test appears to be proving.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setOnline(true);
  supa = makeSupabaseFake({ session: makeSession({ user: { id: USER_ID, email: "a@b.c" } }) });
  h.supa = supa;
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

// ── PART 1: loadWorkspace ─────────────────────────────────────────────────────

describe("loadWorkspace — a request that never answers", () => {
  it("serves the cached workspace once WORKSPACE_AUTH_TIMEOUT_MS has passed", async () => {
    seedStoredSession();
    seedWorkspaceCache();
    supa.auth.hang("getUser");

    const p = loadWorkspace();
    const state = watch(p);

    await vi.advanceTimersByTimeAsync(WORKSPACE_AUTH_TIMEOUT_MS - 1);
    // If this is already true the bound is coming from somewhere else.
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const ws = await p;

    expect(ws.user?.id).toBe(USER_ID);
    expect(ws.membership?.tenant_id).toBe(TENANT_ID);
    expect(ws.groups.map((g) => g.id)).toEqual([GROUP_ID]);
    // Auth never answered, so no table read may have been attempted.
    expect(supa.calls).toHaveLength(0);
  });

  it("still refuses another account's cache — the shared-band-device boundary", async () => {
    // Same hang, same disk, different owner. Serving this would show one band's
    // whole workspace to whoever signed in next on the shared laptop.
    seedStoredSession(USER_ID);
    seedWorkspaceCache(OTHER_USER_ID);
    supa.auth.hang("getUser");

    const p = loadWorkspace();
    await vi.advanceTimersByTimeAsync(WORKSPACE_AUTH_TIMEOUT_MS);
    const ws = await p;

    expect(ws.groups).toEqual([]);
    expect(ws.groupRoles).toEqual([]);
    expect(ws.membership).toBeNull();
    expect(ws.tenant).toBeNull();
    expect(ws.user).toBeNull();
    expect(JSON.stringify(ws)).not.toContain(OTHER_USER_ID);
  });

  it("serves the cache when the parallel table read never settles", async () => {
    seedStoredSession();
    seedWorkspaceCache();
    supa.setScript({
      tenant_members: ok([{ tenant_id: TENANT_ID, role: "member" }]),
      group_roles: ok([{ group_id: GROUP_ID, role: "member" }]),
    });
    // Held open for ever: Promise.all cannot settle without it.
    const held = supa.defer("tenants");

    const p = loadWorkspace();
    const state = watch(p);
    await settleMicrotasks();
    expect(held.taken).toBe(true);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(WORKSPACE_READ_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const ws = await p;

    expect(ws.tenant?.id).toBe(TENANT_ID);
    expect(ws.groups.map((g) => g.id)).toEqual([GROUP_ID]);
  });
});

describe("loadWorkspace — auth that answers, badly", () => {
  it("takes the cached path when getUser() resolves with no user", async () => {
    // auth-js does NOT reject on a network failure; it hands back user: null.
    seedStoredSession();
    seedWorkspaceCache();
    supa.auth.setSession(null);

    const ws = await loadWorkspace();

    expect(ws.user?.id).toBe(USER_ID);
    expect(ws.groups.map((g) => g.id)).toEqual([GROUP_ID]);
    expect(supa.calls).toHaveLength(0);
  });

  it("takes the same cached path when getUser() rejects outright", async () => {
    seedStoredSession();
    seedWorkspaceCache();
    supa.auth.getUser.mockImplementationOnce(() => Promise.reject(new Error("Failed to fetch")));

    const ws = await loadWorkspace();

    expect(ws.user?.id).toBe(USER_ID);
    expect(ws.membership?.role).toBe("member");
    expect(supa.calls).toHaveLength(0);
  });

  it("returns an empty workspace rather than a stranger's when there is no owner match", async () => {
    seedStoredSession(USER_ID);
    seedWorkspaceCache(OTHER_USER_ID);
    supa.auth.setSession(null);

    const ws = await loadWorkspace();

    expect(ws.groups).toEqual([]);
    expect(ws.user).toBeNull();
  });
});

describe("loadWorkspace — offline", () => {
  it("serves the cache without touching the network at all", async () => {
    seedStoredSession();
    seedWorkspaceCache();
    setOnline(false);

    const ws = await loadWorkspace();

    expect(ws.groups.map((g) => g.id)).toEqual([GROUP_ID]);
    // The point of the offline branch: no doomed request, no doomed token refresh,
    // no waiting for either to time out.
    expect(supa.calls).toHaveLength(0);
    expect(supa.from).not.toHaveBeenCalled();
    expect(supa.auth.getUser).not.toHaveBeenCalled();
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("does not resurface another account's cache offline either", async () => {
    seedStoredSession(USER_ID);
    seedWorkspaceCache(OTHER_USER_ID);
    setOnline(false);

    const ws = await loadWorkspace();

    expect(ws.groups).toEqual([]);
    // The stored identity still comes through — the app stays signed in, it just
    // has nothing of this user's to show yet.
    expect(ws.user?.id).toBe(USER_ID);
  });
});

describe("loadWorkspace — an errored read must not become an empty one", () => {
  it("returns the cache and leaves it byte-for-byte unchanged", async () => {
    seedStoredSession();
    const before = seedWorkspaceCache();
    supa.setScript({
      tenant_members: ok([{ tenant_id: TENANT_ID, role: "member" }]),
      // postgrest resolves a network failure as { data: null, error } — coercing
      // this to [] would cache a workspace with no per-band roles at all.
      group_roles: fail("Failed to fetch", 500),
      tenants: ok([{ id: TENANT_ID, name: "A Lot Of Tone" }]),
      groups: ok([{ id: GROUP_ID, name: "Seishin Kakumei" }]),
    });

    const ws = await loadWorkspace();

    expect(ws.groupRoles).toEqual([{ group_id: GROUP_ID, role: "member" }]);
    expect(window.localStorage.getItem(WS_RAW_KEY)).toBe(before);
  });

  it("writes the cache through on a complete read", async () => {
    // The control: the timeouts must not have changed what a healthy load does.
    seedStoredSession();
    seedWorkspaceCache();
    supa.setScript({
      tenant_members: ok([{ tenant_id: TENANT_ID, role: "admin" }]),
      group_roles: ok([{ group_id: GROUP_ID, role: "leader" }]),
      tenants: ok([{ id: TENANT_ID, name: "A Lot Of Tone (fresh)" }]),
      groups: ok([{ id: GROUP_ID, name: "Seishin Kakumei" }, { id: "g2", name: "Other" }]),
    });

    const ws = await loadWorkspace();

    expect(ws.membership?.role).toBe("admin");
    expect(ws.groups).toHaveLength(2);
    expect(ws.perms.tenantRole).toBe("admin");
    const stored = JSON.parse(window.localStorage.getItem(WS_RAW_KEY) ?? "null");
    expect(stored.tenant.name).toBe("A Lot Of Tone (fresh)");
    expect(stored.groups).toHaveLength(2);
  });
});

// ── PART 2: loadEventsList — the same hazard one module over ──────────────────

describe("loadEventsList — a request that never answers", () => {
  it("serves the cached list once EVENTS_LIST_TIMEOUT_MS has passed", async () => {
    // Without the bound this promise never settles and the dashboard renders
    // "กำลังโหลดงาน…" until the app is killed, with this exact list on disk.
    const before = seedEventsCache();
    const held = supa.defer("events");

    const p = loadEventsList(TENANT_ID, VIEWABLE);
    const state = watch(p);
    await settleMicrotasks();
    expect(held.taken).toBe(true);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENTS_LIST_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const rows = await p;

    expect(rows.map((r) => r.id)).toEqual([cachedEvents[0].id]);
    // A timeout is not a result: it must never overwrite what it fell back to.
    expect(window.localStorage.getItem(EVENTS_RAW_KEY)).toBe(before);
  });

  it("serves the cache when an empty read cannot be proven to have carried a token", async () => {
    // The anon-RLS lie plus a black-holed getSession(): hasLiveSession() hangs on
    // the same dead network, so the second await needs a bound too — but its OWN,
    // much shorter one. These bounds stack on the way to the dashboard, and this is
    // a secondary probe on a network that has already answered once; a fresh full
    // read budget here is what pushed the wait past the point operators force-quit.
    const before = seedEventsCache();
    supa.setScript({ events: ok([]) });
    supa.auth.hang("getSession");

    const p = loadEventsList(TENANT_ID, VIEWABLE);
    const state = watch(p);
    await settleMicrotasks();
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(EVENTS_LIST_SESSION_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const rows = await p;

    expect(rows.map((r) => r.id)).toEqual([cachedEvents[0].id]);
    expect(window.localStorage.getItem(EVENTS_RAW_KEY)).toBe(before);
  });
});

describe("loadEventsList — the branches the bound joins", () => {
  it("serves the cache on an errored read", async () => {
    const before = seedEventsCache();
    supa.setScript({ events: fail("Failed to fetch", 500) });

    const rows = await loadEventsList(TENANT_ID, VIEWABLE);

    expect(rows.map((r) => r.id)).toEqual([cachedEvents[0].id]);
    expect(window.localStorage.getItem(EVENTS_RAW_KEY)).toBe(before);
  });

  it("serves the cache offline without issuing a request", async () => {
    seedEventsCache();
    setOnline(false);

    const rows = await loadEventsList(TENANT_ID, VIEWABLE);

    expect(rows).toHaveLength(1);
    expect(supa.calls).toHaveLength(0);
  });

  it("returns and caches a successful read unchanged", async () => {
    // The control for part 2: the race must be invisible on the happy path.
    seedEventsCache();
    const fresh = [
      { id: "ffffffff-0000-4000-8000-000000000001", name: "fresh show", groups: null },
      { id: "ffffffff-0000-4000-8000-000000000002", name: "fresher show", groups: null },
    ];
    supa.setScript({ events: ok(fresh) });

    const rows = await loadEventsList(TENANT_ID, VIEWABLE);

    expect(rows.map((r) => r.id)).toEqual(fresh.map((r) => r.id));
    expect(JSON.parse(window.localStorage.getItem(EVENTS_RAW_KEY) ?? "null")).toHaveLength(2);
    // And it went out as the query the dashboard actually needs.
    const call = supa.lastCall("events", "select");
    expect(call?.eq).toMatchObject({ tenant_id: TENANT_ID, is_template: false, is_practice: false });
    expect(call?.filters.some((f) => f.op === "in" && f.column === "group_id")).toBe(true);
  });

  it("caches a genuinely empty read once the session is proven live", async () => {
    // Symmetry check for the bound above: a real empty answer still writes through,
    // so the timeout has not quietly turned "no shows" into "keep the old list".
    seedEventsCache();
    supa.setScript({ events: ok([]) });

    const rows = await loadEventsList(TENANT_ID, VIEWABLE);

    expect(rows).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(EVENTS_RAW_KEY) ?? "null")).toEqual([]);
  });
});
