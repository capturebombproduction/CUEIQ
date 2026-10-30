// An event bundle on a FULL read-cache. 2026-10-30, hunt 10: the loader's writeCache
// failed silently once the origin's ~5 M chars were used up (nothing was ever dropped,
// and every bundle carries its band's whole song list). A show opened or prepared online
// then had nothing on disk for the no-wifi venue, and a held show's re-read kept last
// week's copy while warmEventBundle - and the dashboard's badge - still called it ready.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/mgmt-outbox", () => ({
  pendingMgmtOps: vi.fn(() => Promise.resolve([])),
  listMgmtConflicts: vi.fn(() => Promise.resolve([])),
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
}));

import { isEventBundleCached, loadEventBundle, warmEventBundle } from "./event-bundle";

const QUOTA = 5_000_000; // jsdom's per-origin localStorage quota, in UTF-16 code units
const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP = "bbbbbbbb-0000-4000-8000-000000000001";
const rawKey = (id: string) => `cueiq:cache:event:${id}`;

const eventRow = (id: string, event_date: string | null) => ({
  id, name: `show ${id}`, tenant_id: TENANT, group_id: GROUP, event_date, is_practice: false,
  groups: { id: GROUP, name: "Seishin Kakumei" },
});
const row = (id: string, eventId: string, sort: number) => ({
  id, event_id: eventId, sort_order: sort, song_id: null, title: `row ${id}`, notes: "n".repeat(1_500),
});
const SONGS = [{ id: "song-1", group_id: GROUP, title: "แสงสุดท้าย", notes: "x".repeat(40_000) }];
/** A bundle as the loader writes it, padded to about `size` chars by its song list. */
function onDisk(id: string, event_date: string | null, setlist: unknown[], size = 40_000) {
  return {
    event: { ...eventRow(id, event_date), groups: undefined, group: { id: GROUP, name: "Seishin Kakumei" } },
    schedule: [], setlist, micMap: [], members: [],
    songs: [{ ...SONGS[0], notes: "x".repeat(size) }],
    lineup: [], role: "member",
  };
}
function used(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    n += k.length + (localStorage.getItem(k) ?? "").length;
  }
  return n;
}
/** Fill the origin with something that is not a bundle until `free` code units are left. */
function fillLeaving(free: number) {
  const key = "cueiq:cache:workspace";
  localStorage.setItem(key, "w".repeat(QUOTA - used() - key.length - free));
}
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

let supa: SupabaseFake;
function serve(event: ReturnType<typeof eventRow>, setlist: unknown[]) {
  supa = makeSupabaseFake({
    session: makeSession(),
    // the band's song list, as big as the one on disk - the bulk of every real bundle
    script: { events: ok([event]), setlist_items: ok(setlist), songs: ok(SONGS) },
  });
  h.supa = supa;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T05:00:00Z")); // Bangkok 2026-10-30
  setOnline(true);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
  localStorage.clear();
});

describe("event bundle on a full read-cache", () => {
  it("a new show's bundle reaches the disk by dropping a show over a week past", async () => {
    localStorage.setItem(rawKey("old"), JSON.stringify(onDisk("old", "2026-08-01", [])));
    fillLeaving(5_000);
    serve(eventRow("next", "2026-10-31"), [row("r1", "next", 1), row("r2", "next", 2)]);

    expect(await warmEventBundle("next")).toBe(true);
    expect(isEventBundleCached("next")).toBe(true);
    expect(localStorage.getItem(rawKey("old"))).toBeNull();
    // and the venue door opens it with no network
    setOnline(false);
    expect((await loadEventBundle("next"))?.setlist.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("a held show whose newer read cannot be written keeps its older copy for the venue - but is no longer ready", async () => {
    localStorage.setItem(rawKey("held"), JSON.stringify(onDisk("held", "2026-10-31", [row("r1", "held", 1)])));
    // nothing here may be dropped: tomorrow's show, an undated draft, and non-bundles
    localStorage.setItem(rawKey("draft"), JSON.stringify(onDisk("draft", null, [])));
    fillLeaving(1_000);
    const old = localStorage.getItem(rawKey("held"));
    expect(isEventBundleCached("held")).toBe(true);
    // the band added two rows on a phone: the new bundle is ~3 K bigger than the old one
    serve(eventRow("held", "2026-10-31"), [row("r1", "held", 1), row("r2", "held", 2), row("r3", "held", 3)]);

    expect(await warmEventBundle("held")).toBe(false);
    expect(isEventBundleCached("held")).toBe(false);
    expect(localStorage.getItem(rawKey("held"))).toBe(old);
    // with no network the older copy still opens - something, rather than nothing
    setOnline(false);
    expect((await loadEventBundle("held"))?.setlist.map((r) => r.id)).toEqual(["r1"]);

    // room again (an old show dropped, the song list shrank…): the next read lands and it is ready
    setOnline(true);
    localStorage.removeItem("cueiq:cache:workspace");
    expect(await warmEventBundle("held")).toBe(true);
    expect(isEventBundleCached("held")).toBe(true);
  });
});
