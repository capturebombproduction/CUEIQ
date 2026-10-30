// คลังเพลง's read-cache keeps no covers. 2026-10-30, hunt 10: fetchSongs wrote the rows as
// read ("*"), and a cover is a ~10 K-char data URL - Seishin's 36 were ~360 K of the ~400 K
// this one entry took, re-written on every dashboard open, in the few-MB localStorage the
// show bundles, the saved sign-in and Live's crash snapshots share. The caller still gets
// the covers (the online Library draws them); only the copy on disk goes without.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { fetchSongs, readCachedSongs, songsCacheKey } from "./song-library";

const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP = "bbbbbbbb-0000-4000-8000-000000000001";
const COVER = "data:image/webp;base64," + "A".repeat(10_000);
const ROWS = [
  { id: "song-1", tenant_id: TENANT_ID, group_id: GROUP, title: "แสงสุดท้าย", cover: COVER, peaks: "p".repeat(200) },
  { id: "song-2", tenant_id: TENANT_ID, group_id: GROUP, title: "ไม่มีปก", cover: null },
];

beforeEach(() => {
  window.localStorage.clear();
  h.supa = makeSupabaseFake({ session: makeSession(), script: { songs: ok(ROWS) } });
});
afterEach(() => window.localStorage.clear());

describe("fetchSongs: the cached catalogue", () => {
  it("hands the caller every cover it read", async () => {
    const rows = await fetchSongs(TENANT_ID, [GROUP]);
    expect(rows?.map((r) => r.cover)).toEqual([COVER, null]);
  });

  it("writes the rows to disk without their covers - everything else as read", async () => {
    await fetchSongs(TENANT_ID, [GROUP]);
    const cached = readCachedSongs(TENANT_ID, [GROUP]);
    expect(cached).toHaveLength(2);
    for (const row of cached ?? []) expect("cover" in row).toBe(false);
    const { cover: _c1, ...rest1 } = ROWS[0];
    const { cover: _c2, ...rest2 } = ROWS[1];
    void _c1;
    void _c2;
    expect(cached).toEqual([rest1, rest2]);
    expect(window.localStorage.getItem(`cueiq:cache:${songsCacheKey(TENANT_ID, [GROUP])}`)!.length).toBeLessThan(1_000);
  });
});
