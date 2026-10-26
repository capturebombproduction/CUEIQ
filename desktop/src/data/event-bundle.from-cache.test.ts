import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// 2026-10-27 (hunt 6): a bundle served from this device's read-cache says so.
//
// pages/event.tsx re-reads the bundle on every router.refresh() (บันทึก / อัปเดต, the
// Summary tab, the auto status write). With no server to reach, that re-read is the
// read-cache - the last ONLINE read plus the edits queued here - and it arrived looking
// exactly like a server read. EventWorkspace re-seeded a tab waiting for "the next read"
// from it: a label saved online as C after that read came back as B, and the next blur
// wrote B over C. The bundle now carries `fromCache` so the page can tell the workspace
// (`cachedCopy`). The flag is on the copy handed out, never in what is stored.

const h = vi.hoisted(() => ({ supa: null as unknown, ops: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/mgmt-outbox", () => ({
  pendingMgmtOps: vi.fn(() => Promise.resolve(h.ops)),
  listMgmtConflicts: vi.fn(() => Promise.resolve([])),
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
}));

import { EVENT_BUNDLE_TIMEOUT_MS, loadEventBundle, loadEventBundleStatus } from "./event-bundle";

const EVENT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const rawKey = (id: string) => `cueiq:cache:event:${id}`;

function seedBundleCache(): string {
  const raw = JSON.stringify({
    event: { id: EVENT_ID, name: "cached show", tenant_id: TENANT_ID, group_id: GROUP_ID, group: null },
    schedule: [{ id: "s1", event_id: EVENT_ID, kind: "stage", label: "B", start_time: "19:00:00" }],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
    role: "member",
  });
  window.localStorage.setItem(rawKey(EVENT_ID), raw);
  return raw;
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

let supa: SupabaseFake;
beforeEach(() => {
  h.ops = [];
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setOnline(true);
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      events: ok([
        {
          id: EVENT_ID,
          name: "fresh show",
          tenant_id: TENANT_ID,
          group_id: GROUP_ID,
          event_date: "2026-08-09",
          groups: { id: GROUP_ID, name: "Seishin Kakumei" },
        },
      ]),
    },
  });
  h.supa = supa;
});
afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe("loadEventBundle · a copy served from the read-cache is marked as one", () => {
  it("offline: the cached bundle comes back with fromCache, and the stored copy is untouched", async () => {
    const before = seedBundleCache();
    setOnline(false);
    const { bundle } = await loadEventBundleStatus(EVENT_ID);
    expect(bundle?.event.name).toBe("cached show");
    expect(bundle?.fromCache).toBe(true);
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).toBe(before);
  });

  it("a read that never answers: the cache it falls back to is marked too (loadEventBundle, the re-read's call)", async () => {
    seedBundleCache();
    supa.defer("events"); // the black-holed venue AP that still reports itself online
    const p = loadEventBundle(EVENT_ID);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(EVENT_BUNDLE_TIMEOUT_MS);
    const bundle = await p;
    expect(bundle?.event.name).toBe("cached show");
    expect(bundle?.fromCache).toBe(true);
  });

  it("a server read is not marked - and is what gets stored", async () => {
    const { bundle } = await loadEventBundleStatus(EVENT_ID);
    expect(bundle?.event.name).toBe("fresh show");
    expect(bundle?.fromCache).toBeUndefined();
    expect(window.localStorage.getItem(rawKey(EVENT_ID))).not.toContain("fromCache");
  });
});
