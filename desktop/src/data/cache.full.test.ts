// A FULL read-cache. 2026-10-30, hunt 10: writeCache swallowed QuotaExceededError and
// nothing was ever dropped, while every event bundle carries its band's whole song list
// (~48 K chars for Seishin's 40 songs; the origin holds ~5.2 M in Chromium, 5 M in jsdom,
// shared with the saved sign-in and Live's crash snapshots). A laptop that opened every
// show filled up within months, and from then on the next show's bundle silently never
// reached the disk. writeCache now drops the bundles of shows more than a week past,
// oldest first, and says whether the write landed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readCache, writeCache } from "./cache";

const QUOTA = 5_000_000; // jsdom's per-origin localStorage quota, in UTF-16 code units
const P = "cueiq:cache:";

/** A bundle of roughly `size` chars (the song list is what makes the real ones big). */
function bundle(id: string, event_date: string | null, size = 40_000, extra: Record<string, unknown> = {}) {
  return {
    event: { id, name: `show ${id}`, event_date, is_practice: false, ...extra },
    schedule: [],
    setlist: [],
    micMap: [],
    members: [],
    songs: [{ id: "song-1", title: "New Preset Identity 【新・抗う自我】", notes: "x".repeat(size) }],
    lineup: [],
    role: "member",
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

/** Fill the origin with something that is NOT a bundle (the workspace, the song list…)
 *  until only `free` code units are left. */
function fillLeaving(free: number) {
  const key = `${P}workspace`;
  localStorage.setItem(key, "w".repeat(QUOTA - used() - key.length - free));
}

const raw = (key: string) => localStorage.getItem(P + key);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-10-30 12:00 in Bangkok: "over a week past" = dated before 2026-10-23
  vi.setSystemTime(new Date("2026-10-30T05:00:00Z"));
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("writeCache on a full cache", () => {
  it("says true for an ordinary write", () => {
    expect(writeCache("crew:t", [{ id: "c1" }])).toBe(true);
    expect(readCache("crew:t")).toEqual([{ id: "c1" }]);
  });

  it("makes room for the next show by dropping the oldest show over a week past - only as many as it needs", () => {
    writeCache("event:b", bundle("b", "2026-10-01"));
    writeCache("event:a", bundle("a", "2026-09-01"));
    writeCache("event:c", bundle("c", "2026-10-22"));
    localStorage.setItem("cueiq:live:x", JSON.stringify({ state: { begun: true } })); // Live's crash snapshot
    fillLeaving(10_000);
    const before = { b: raw("event:b"), c: raw("event:c"), live: localStorage.getItem("cueiq:live:x"), ws: raw("workspace") };

    const next = bundle("n", "2026-11-01", 45_000);
    expect(writeCache("event:n", next)).toBe(true);
    expect(readCache("event:n")).toEqual(next);
    // the oldest went, and it was enough: the later past shows and everything else stay
    expect(raw("event:a")).toBeNull();
    expect(raw("event:b")).toBe(before.b);
    expect(raw("event:c")).toBe(before.c);
    expect(localStorage.getItem("cueiq:live:x")).toBe(before.live);
    expect(raw("workspace")).toBe(before.ws);
  });

  it("never drops a show inside the week, an undated show, a practice room or anything that is not a bundle - and says the write did not land", () => {
    writeCache("event:recent", bundle("recent", "2026-10-23")); // exactly a week: kept
    writeCache("event:undated", bundle("undated", null));
    writeCache("event:room", bundle("room", "2026-06-01", 40_000, { is_practice: true }));
    writeCache("runlive:f", { pad: "r".repeat(20_000) });
    fillLeaving(1_000);
    const before = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));

    expect(writeCache("event:n", bundle("n", "2026-11-01", 45_000))).toBe(false);
    expect(readCache("event:n")).toBeNull();
    expect(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))).toEqual(before);
  });

  it("never drops the entry being written: a held past show that grew keeps its old copy when nothing else may go", () => {
    writeCache("event:held", bundle("held", "2026-09-01", 40_000));
    writeCache("event:undated", bundle("undated", null));
    fillLeaving(1_000);
    const old = raw("event:held");

    expect(writeCache("event:held", bundle("held", "2026-09-01", 45_000))).toBe(false);
    expect(raw("event:held")).toBe(old);
  });
});
