// The desktop song catalogue read + its read-cache, in one place.
//
// คลังเพลง is the ONLY door to the offline audio-upload queue (⭐#1): picking a
// file for a song at the venue, playing it on this machine immediately, and
// pushing it as the master when the network comes back. Round 6 gave the page a
// read-cache so that door isn't locked offline — but the page itself was the only
// thing that ever WROTE that cache, so a fresh install that logged in and drove
// straight to a venue arrived with nothing cached and the door still shut.
//
// So the loader lives here and the dashboard warms it on the way past. Same key,
// same guards, one implementation — the cache the venue reads can't drift from
// the cache the app writes.
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import type { Song } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";

/** How long ONE read here may wait on Supabase before the read is written off.
 *
 *  fetchSongs already answers `null` for every read it cannot trust, and library.tsx
 *  falls back to readCachedSongs on null — but a read that never SETTLES never
 *  returns null either, so the fallback never runs and คลังเพลง waits instead. That
 *  is the venue case: wifi JOINED, navigator.onLine TRUE (so isOffline() is false),
 *  TCP connects, nothing ever answers. Same budget as the loaders round 11 already
 *  bounded; a timeout takes the module's existing "could not trust it" branch. */
export const SONG_LIBRARY_TIMEOUT_MS = 8000;

/** Resolves to `null` if `p` has not settled within `ms`. The in-flight request is
 *  deliberately NOT cancelled — a late answer can still warm the cache for the next
 *  screen; we simply stop waiting on it. (Mirrors ~/data/workspace.ts, which owns
 *  the canonical comment; kept local because that copy is not exported.) */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    // Without this the pending timer keeps a handle alive for its full duration
    // after every fast, successful load.
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Cache key for one tenant + set of bands. Order-independent: the caller's band
 *  list comes from permissions and must not produce two entries for one scope. */
export function songsCacheKey(tenantId: string, groupIds: string[]): string {
  return `songs:${tenantId}:${[...groupIds].sort().join(",")}`;
}

export function readCachedSongs(tenantId: string, groupIds: string[]): Song[] | null {
  return readCache<Song[]>(songsCacheKey(tenantId, groupIds));
}

/**
 * Fetch the catalogue for `groupIds` and write it through to the cache.
 * Returns null when the read could not be trusted — offline, a postgrest error,
 * a read that never answered, or an empty answer we can't prove carried our token
 * (an anon RLS refusal reads exactly like an empty library, and caching it would
 * wipe this device's copy). Callers fall back to `readCachedSongs` on null.
 */
export async function fetchSongs(
  tenantId: string,
  groupIds: string[]
): Promise<Song[] | null> {
  if (groupIds.length === 0) return [];
  if (isOffline()) return null;
  // A request that NEVER answers is the same situation as one that fails, so it
  // takes the same branch: null, and the caller serves readCachedSongs.
  const res = await withTimeout(
    createClient()
      .from("songs")
      .select("*")
      .eq("tenant_id", tenantId)
      .in("group_id", groupIds)
      .order("created_at", { ascending: false }),
    SONG_LIBRARY_TIMEOUT_MS
  );
  if (!res || res.error) return null;
  const rows = (res.data ?? []) as Song[];
  // Bounded too: getSession() can attempt a token refresh over the same dead
  // network. Anything short of a proven-live session leaves the empty answer
  // untrustworthy, which is exactly what this guard already treats it as.
  if (rows.length === 0 && (await withTimeout(hasLiveSession(), SONG_LIBRARY_TIMEOUT_MS)) !== true) {
    return null;
  }
  writeCache(songsCacheKey(tenantId, groupIds), rows);
  return rows;
}

/**
 * Leave the catalogue in the read-cache so คลังเพลง opens with no network.
 * Best-effort and silent: this rides along with a page the user opened for some
 * other reason, so a failure must never surface or throw.
 */
export async function warmSongLibrary(
  tenantId: string,
  groupIds: string[]
): Promise<void> {
  if (groupIds.length === 0 || isOffline()) return;
  try {
    await fetchSongs(tenantId, groupIds);
  } catch {
    /* best-effort, same contract as the read-cache itself */
  }
}
