// lib/song-covers.ts - an empty answer is not "these songs have no cover".
//
// 2026-10-27, hunt 9: a read sent as anon (a laptop that just woke, its token refresh not
// through yet) is answered by RLS with no rows and no error. The hook took that as "no
// cover" for every song it asked about and never asked again, so Live's NOW card and the
// practice hero showed no covers until a reload - days, for a page left open.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let answer: { data: unknown; error: unknown } = { data: [], error: null };
let calls = 0;
let live = false;
let gate: Promise<boolean> | null = null;
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: () => {
          calls++;
          return Promise.resolve(answer);
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: () => gate ?? Promise.resolve(live) }));

import { useSongCovers, resetSongCoverCache } from "./song-covers";

const A = "data:image/webp;base64,QQ==";

beforeEach(() => {
  resetSongCoverCache();
  calls = 0;
  live = false;
  gate = null;
  answer = { data: [], error: null };
});

describe("useSongCovers - an empty answer", () => {
  it("is not remembered without a proven session, so a later visit asks again and shows the cover", async () => {
    const first = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(first.result.current).toEqual({});
    first.unmount();
    live = true;
    answer = { data: [{ id: "a", cover: A }], error: null };
    const later = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(later.result.current).toEqual({ a: A }));
    expect(calls).toBe(2);
  });

  it("is believed when the session is proven (the song really has no cover), and not asked again", async () => {
    live = true;
    const first = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(first.result.current).toEqual({ a: null }));
    first.unmount();
    const again = renderHook(() => useSongCovers(["a"]));
    expect(again.result.current).toEqual({ a: null });
    expect(calls).toBe(1);
  });

  // ตาที่ 3 on hunt 9: the songs were let go of ("asking") BEFORE the session check, so a
  // second screen mounting meanwhile sent a second read for the same songs.
  it("keeps the songs 'asked' across the session check, so a screen mounting meanwhile sends no second read", async () => {
    let release: (v: boolean) => void = () => {};
    gate = new Promise<boolean>((r) => (release = r));
    const first = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(calls).toBe(1));
    const second = renderHook(() => useSongCovers(["a"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    release(true);
    await waitFor(() => expect(second.result.current).toEqual({ a: null }));
    expect(first.result.current).toEqual({ a: null });
  });
});
