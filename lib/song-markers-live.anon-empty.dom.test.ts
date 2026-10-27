// lib/song-markers-live.ts - the markers this device keeps for an offline venue.
//
// 2026-10-27, hunt 7: a read sent as anon (a token refresh that had just failed) is answered
// by RLS with no rows and no error, and the hook took that as "these songs have no sections":
// it wrote [] over every song it asked about and saved it, so Live's NOW card had no section
// labels once the wifi went. And the ids it asked about were never let go after an answer, so
// a desktop open all day never saw a marker set in the practice room that afternoon.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let answer: { data: unknown; error: unknown } = { data: [], error: null };
let calls = 0;
let live = false;
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          order: () => {
            calls++;
            return Promise.resolve(answer);
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => live }));

import { useSongMarkers, resetSongMarkerCache } from "./song-markers-live";

const KEY = "cueiq:songMarkers:v1";

beforeEach(() => {
  resetSongMarkerCache();
  calls = 0;
  live = false;
  answer = { data: [], error: null };
});

describe("useSongMarkers - an empty answer and a later visit", () => {
  it("keeps the stored markers when an empty answer comes back without a proven session", async () => {
    localStorage.setItem(KEY, JSON.stringify({ a: [{ label: "CHORUS", at: 60 }] }));
    const { result } = renderHook(() => useSongMarkers(["a"]));
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.a).toEqual([{ label: "CHORUS", at: 60 }]);
    expect(JSON.parse(localStorage.getItem(KEY)!).a).toEqual([{ label: "CHORUS", at: 60 }]);
  });

  it("believes an empty answer when the session is proven (the markers really were removed)", async () => {
    live = true;
    localStorage.setItem(KEY, JSON.stringify({ a: [{ label: "CHORUS", at: 60 }] }));
    const { result } = renderHook(() => useSongMarkers(["a"]));
    await waitFor(() => expect(result.current.a).toEqual([]));
  });

  it("asks again on a later visit, so a marker added since shows up", async () => {
    answer = { data: [{ song_id: "a", label: "VERSE", position_seconds: 10, sort_order: 0 }], error: null };
    const first = renderHook(() => useSongMarkers(["a"]));
    await waitFor(() => expect(first.result.current.a).toEqual([{ label: "VERSE", at: 10 }]));
    first.unmount();
    answer = {
      data: [
        { song_id: "a", label: "VERSE", position_seconds: 10, sort_order: 0 },
        { song_id: "a", label: "CHORUS", position_seconds: 50, sort_order: 1 },
      ],
      error: null,
    };
    const later = renderHook(() => useSongMarkers(["a"]));
    await waitFor(() => expect(later.result.current.a).toHaveLength(2));
    expect(calls).toBe(2);
  });
});
