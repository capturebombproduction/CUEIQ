"use client";

// Song covers for screens that are NOT the Library: the event bundle leaves the cover
// pictures out (lib/song-columns.ts says why), so Live Mode's NOW card and the practice
// room's Now Playing ask for the few they show, here.
//
// Decoration only, and built so it can never get in a show's way:
//   • one read per new set of ids (`songs id, cover`), never awaited by anything;
//   • a failed or hanging read just leaves no cover — no retry loop, no error UI;
//   • answers are kept for the visit in a module-level map, so moving between pages, or
//     to the next song, costs nothing. A song the read did not return (deleted, not
//     visible) is remembered as "no cover" so it is not asked for again.
// Nothing is written to disk: the desktop's offline show simply has no covers.

import { useEffect, useMemo, useState } from "react";
// Absolute path so the desktop build's "@/lib/supabase/client" alias applies.
import { createClient } from "@/lib/supabase/client";

const known = new Map<string, string | null>();
const asking = new Set<string>();
// every mounted hook, told when ANY read lands: a hook that mounts while another one
// is already asking about its songs (a remount, StrictMode) must still hear the answer
const listeners = new Set<() => void>();

/** For tests: forget every answer. */
export function resetSongCoverCache(): void {
  known.clear();
  asking.clear();
  listeners.clear();
}

function snapshot(ids: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const id of ids) if (known.has(id)) out[id] = known.get(id) ?? null;
  return out;
}

/** The covers of `ids` this visit has learned so far: id → data URL, or null for none.
 *  An id still being asked about is simply absent. */
export function useSongCovers(ids: readonly (string | null | undefined)[]): Record<string, string | null> {
  // one stable key per SET of ids, so a new array with the same songs asks nothing
  const key = useMemo(
    () => Array.from(new Set(ids.filter((x): x is string => !!x))).sort().join(","),
    [ids]
  );
  const [covers, setCovers] = useState<Record<string, string | null>>(() =>
    snapshot(key ? key.split(",") : [])
  );
  useEffect(() => {
    const wanted = key ? key.split(",") : [];
    const update = () => setCovers(snapshot(wanted));
    update();
    listeners.add(update);
    const stop = () => {
      listeners.delete(update);
    };
    const missing = wanted.filter((id) => !known.has(id) && !asking.has(id));
    if (missing.length === 0) return stop;
    missing.forEach((id) => asking.add(id));
    const done = () => missing.forEach((id) => asking.delete(id));
    try {
      createClient()
        .from("songs")
        .select("id, cover")
        .in("id", missing)
        .then(
          ({ data, error }) => {
            done();
            if (error || !data) return; // not known: a later visit may ask again
            const got = new Map((data as { id: string; cover: string | null }[]).map((r) => [r.id, r.cover]));
            for (const id of missing) known.set(id, got.get(id) ?? null);
            listeners.forEach((l) => l());
          },
          () => done()
        );
    } catch {
      done(); // no client (a test, a broken build): no covers
    }
    return stop;
  }, [key]);
  return covers;
}
