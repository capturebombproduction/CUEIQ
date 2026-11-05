"use client";

// The Library's cover pictures, read in the browser instead of riding in the page.
//
// Measured 2026-11-05: songs.cover is a ~10 K-char data URL, Seishin's 36 came to 362 K
// chars, and the web Library sent each one THREE times in its HTML (the desktop table's
// <img>, the phone list's <img>, and the RSC payload that hydrates them) - ~1.1 MB of
// base64 on every open, plus 362 K again on every router.refresh() (the refresh key, the
// save bar). The page now reads every column but `cover` (lib/song-columns.ts) and passes
// `lazyCovers`; this reads the covers once per visit, in one request, and keeps them in a
// module-level map so moving between pages and back costs nothing.
//
// Kept per song VERSION (`updated_at`, bumped by the songs_touch_updated_at trigger on any
// change): a refresh that brings a newer row - a cover changed on another device - asks
// again for that song only, and shows the cover it had meanwhile (no flash).
//
// Decoration, built so it can never get in the way (the same rules as lib/song-covers.ts,
// which Live and the practice room use - deliberately NOT shared, so this cannot touch them):
//   • never awaited by anything; a failed, empty-as-anon or hanging read just leaves the
//     band tile (after COVER_WAIT_MS for a hang), and nothing retries in a loop;
//   • a song whose row already carries `cover` (the desktop, a row a save just returned) is
//     drawn from the row, exactly as before.

import { useEffect, useMemo, useState } from "react";
// Absolute path so the desktop build's "@/lib/supabase/client" alias applies.
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import type { Song } from "@/lib/types";

/** How long a cover read may hang before its songs show their band tile instead. */
export const COVER_WAIT_MS = 8_000;

type Entry = { v: string; cover: string | null };
// id → the cover as of song version `v`
const known = new Map<string, Entry>();
// `id@version` keys: being read now, or given up on (an error / a hang) for this visit
const asking = new Set<string>();
const gaveUp = new Set<string>();
const listeners = new Set<() => void>();

/** For tests: forget every answer. */
export function resetLibraryCoverCache(): void {
  known.clear();
  asking.clear();
  gaveUp.clear();
  listeners.clear();
}

const versionKey = (s: Pick<Song, "id" | "updated_at">) => `${s.id}@${s.updated_at}`;
const notify = () => listeners.forEach((l) => l());

/**
 * `coverOf(song)`: the data URL to draw, `null` for the band tile, or `undefined` while
 * the cover is still being read (draw a neutral box, not the band tile, so nothing jumps).
 * With `enabled` false every song is drawn from its own row: `song.cover ?? null`.
 */
export function useLibraryCovers(
  songs: readonly Song[],
  enabled: boolean
): (song: Song) => string | null | undefined {
  const [, setTick] = useState(0);
  // the versions this list needs read: rows without `cover` whose version is not known yet
  const wantedKey = useMemo(() => {
    if (!enabled) return "";
    const keys: string[] = [];
    for (const s of songs) {
      if (s.cover !== undefined) continue;
      if (known.get(s.id)?.v === s.updated_at) continue;
      keys.push(versionKey(s));
    }
    return keys.sort().join(",");
  }, [songs, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const update = () => setTick((n) => n + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, [enabled]);

  // A row that carries its cover (a save's answer, a cover just put on or taken off) is the
  // newest cover this visit knows: remembered, so the refresh that follows - its row newer
  // and without `cover` - shows it while that version is read, never the picture before it.
  useEffect(() => {
    if (!enabled) return;
    for (const s of songs) {
      if (s.cover === undefined) continue;
      const prev = known.get(s.id);
      if (prev && prev.v > s.updated_at) continue;
      known.set(s.id, { v: s.updated_at, cover: s.cover ?? null });
    }
  }, [songs, enabled]);

  useEffect(() => {
    if (!wantedKey) return;
    const asked = wantedKey.split(",").filter((k) => !asking.has(k) && !gaveUp.has(k));
    if (asked.length === 0) return;
    asked.forEach((k) => asking.add(k));
    const ids = asked.map((k) => k.slice(0, k.indexOf("@")));
    let settled = false;
    const giveUp = () => {
      if (settled) return;
      settled = true;
      asked.forEach((k) => {
        asking.delete(k);
        gaveUp.add(k);
      });
      notify();
    };
    // A hang (a venue AP with no route out) must not leave grey boxes for the visit.
    // Not cleared on unmount: the read is shared by every hook that wants these songs.
    const timer = setTimeout(giveUp, COVER_WAIT_MS);
    const land = (rows: { id: string; cover: string | null }[]) => {
      const got = new Map(rows.map((r) => [r.id, r.cover]));
      for (const k of asked) {
        const at = k.indexOf("@");
        const id = k.slice(0, at);
        const prev = known.get(id);
        // a newer version another read already stored is never taken back
        if (prev && prev.v > k.slice(at + 1)) continue;
        known.set(id, { v: k.slice(at + 1), cover: got.get(id) ?? null });
      }
    };
    try {
      createClient()
        .from("songs")
        .select("id, cover")
        .in("id", ids)
        .then(
          async ({ data, error }) => {
            try {
              if (error || !data) return giveUp();
              // An EMPTY answer may be a read sent as anon (RLS answers it with no rows and
              // no error): taken at its word every song would be "no cover" for the visit.
              if (data.length === 0 && (await hasLiveSession().catch(() => false)) !== true) return giveUp();
              land(data as { id: string; cover: string | null }[]);
              clearTimeout(timer);
              if (!settled) {
                settled = true;
                asked.forEach((k) => asking.delete(k));
              }
              notify();
            } catch {
              giveUp();
            }
          },
          () => giveUp()
        );
    } catch {
      clearTimeout(timer);
      giveUp(); // no client (a test, a broken build): band tiles
    }
  }, [wantedKey]);

  return (song: Song) => {
    if (!enabled || song.cover !== undefined) return song.cover ?? null;
    const entry = known.get(song.id);
    if (entry && entry.v === song.updated_at) return entry.cover;
    const k = versionKey(song);
    if (gaveUp.has(k)) return entry ? entry.cover : null;
    // still being read: the cover this visit last saw for the song, else the neutral box
    return entry ? entry.cover : undefined;
  };
}
