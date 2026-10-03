// useSongCovers: the covers the event bundle leaves out, read for the screens that show
// one (Live's NOW card, the practice hero). It is decoration on a show screen, so what is
// pinned is that it asks little, remembers what it heard, and never needs a retry loop
// or a second hook's luck to show what it already knows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

type Row = { id: string; cover: string | null };
const h = vi.hoisted(() => ({
  rows: [] as Row[],
  reads: [] as string[][],
  mode: "ok" as "ok" | "error" | "hang",
  release: [] as (() => void)[],
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      let ids: string[] = [];
      const b = {
        select: () => b,
        in: (_col: string, v: string[]) => {
          ids = v;
          return b;
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (table !== "songs") throw new Error("unexpected table " + table);
          h.reads.push([...ids].sort());
          const answer = () =>
            h.mode === "error"
              ? { data: null, error: { message: "503" } }
              : { data: h.rows.filter((r) => ids.includes(r.id)), error: null };
          if (h.mode === "hang")
            return new Promise((r) => h.release.push(() => r(answer()))).then(res, rej);
          return Promise.resolve(answer()).then(res, rej);
        },
      };
      return b;
    },
  }),
}));

import { resetSongCoverCache, useSongCovers } from "./song-covers";

const A = "data:image/webp;base64,QQ==";
const B = "data:image/webp;base64,Qg==";

beforeEach(() => {
  resetSongCoverCache();
  h.rows = [
    { id: "a", cover: A },
    { id: "b", cover: B },
    { id: "c", cover: null },
  ];
  h.reads = [];
  h.mode = "ok";
  h.release = [];
});

describe("useSongCovers", () => {
  it("asks once for the whole set and maps each id to its cover (null = none)", async () => {
    const { result } = renderHook(() => useSongCovers(["a", "b", "c", "a", null]));
    await waitFor(() => expect(result.current).toEqual({ a: A, b: B, c: null }));
    expect(h.reads).toEqual([["a", "b", "c"]]);
  });

  it("remembers a song the read did not return as 'no cover', and never asks again", async () => {
    const first = renderHook(() => useSongCovers(["gone"]));
    await waitFor(() => expect(first.result.current).toEqual({ gone: null }));
    first.unmount();
    const again = renderHook(() => useSongCovers(["gone"]));
    expect(again.result.current).toEqual({ gone: null });
    expect(h.reads).toEqual([["gone"]]);
  });

  it("a new array with the same songs asks nothing; a new song asks only for itself", async () => {
    const { result, rerender } = renderHook(({ ids }) => useSongCovers(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    await waitFor(() => expect(result.current).toEqual({ a: A, b: B }));
    rerender({ ids: ["b", "a"] });
    rerender({ ids: ["a", "b", "c"] });
    await waitFor(() => expect(result.current).toEqual({ a: A, b: B, c: null }));
    expect(h.reads).toEqual([["a", "b"], ["c"]]);
  });

  it("a failed read shows no cover and is not remembered, so a later visit asks again", async () => {
    h.mode = "error";
    const first = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(h.reads).toHaveLength(1));
    expect(first.result.current).toEqual({});
    first.unmount();
    h.mode = "ok";
    const again = renderHook(() => useSongCovers(["a"]));
    await waitFor(() => expect(again.result.current).toEqual({ a: A }));
    expect(h.reads).toHaveLength(2);
  });

  it("a hook that mounts while another is already asking still hears the answer", async () => {
    // a remount (or StrictMode's double effect) lands here: the songs are being asked
    // about, so this hook does not ask again — it must still be told when they land
    h.mode = "hang";
    const first = renderHook(() => useSongCovers(["a"]));
    first.unmount();
    const second = renderHook(() => useSongCovers(["a"]));
    expect(h.reads).toHaveLength(1);
    h.release.forEach((r) => r());
    await waitFor(() => expect(second.result.current).toEqual({ a: A }));
  });

  it("no ids, no read", () => {
    const { result } = renderHook(() => useSongCovers([null, undefined]));
    expect(result.current).toEqual({});
    expect(h.reads).toEqual([]);
  });
});
