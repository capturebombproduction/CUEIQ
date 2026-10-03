// lib/song-markers-live.ts - the practice room's sections for Live's NOW card. A read that
// answers is kept on the device, so a desktop that saw the markers online still has them at
// an offline venue; a read that fails keeps what the device already had.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let answer: { data: unknown; error: unknown } = { data: [], error: null };
let calls = 0;
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

import { useSongMarkers, resetSongMarkerCache } from "./song-markers-live";

beforeEach(() => {
  resetSongMarkerCache();
  calls = 0;
  answer = { data: [], error: null };
});

describe("useSongMarkers", () => {
  it("returns each song's markers in time order, trimmed, and remembers songs that have none", async () => {
    answer = {
      data: [
        { song_id: "a", label: " VERSE ", position_seconds: 14, sort_order: 0 },
        { song_id: "a", label: "CHORUS", position_seconds: 84, sort_order: 1 },
        { song_id: "a", label: "   ", position_seconds: 90, sort_order: 2 }, // blank: dropped
      ],
      error: null,
    };
    const { result } = renderHook(() => useSongMarkers(["a", "b", null]));
    await waitFor(() => expect(result.current.a).toBeDefined());
    expect(result.current.a).toEqual([
      { label: "VERSE", at: 14 },
      { label: "CHORUS", at: 84 },
    ]);
    expect(result.current.b).toEqual([]);
  });

  it("keeps the answer on the device: offline later, the markers are still there", async () => {
    answer = { data: [{ song_id: "a", label: "CHORUS", position_seconds: 60, sort_order: 0 }], error: null };
    const first = renderHook(() => useSongMarkers(["a"]));
    await waitFor(() => expect(first.result.current.a).toBeDefined());
    first.unmount();
    // a fresh visit (module memory gone, the disk kept) at a venue with no network
    const stored = localStorage.getItem("cueiq:songMarkers:v1");
    resetSongMarkerCache();
    localStorage.setItem("cueiq:songMarkers:v1", stored!);
    answer = { data: null, error: { message: "Failed to fetch" } };
    const offline = renderHook(() => useSongMarkers(["a"]));
    expect(offline.result.current.a).toEqual([{ label: "CHORUS", at: 60 }]);
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    expect(offline.result.current.a).toEqual([{ label: "CHORUS", at: 60 }]); // a failed read changed nothing
  });

  it("asks once per visit for a set of songs, however often Live re-renders", async () => {
    const { result, rerender } = renderHook(({ ids }) => useSongMarkers(ids), { initialProps: { ids: ["a", "b"] } });
    await waitFor(() => expect(result.current.a).toBeDefined());
    rerender({ ids: ["b", "a"] });
    rerender({ ids: ["a", "b", "a"] });
    expect(calls).toBe(1);
  });
});
