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
 * or an empty answer we can't prove carried our token (an anon RLS refusal reads
 * exactly like an empty library, and caching it would wipe this device's copy).
 * Callers fall back to `readCachedSongs` on null.
 */
export async function fetchSongs(
  tenantId: string,
  groupIds: string[]
): Promise<Song[] | null> {
  if (groupIds.length === 0) return [];
  if (isOffline()) return null;
  const { data, error } = await createClient()
    .from("songs")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("group_id", groupIds)
    .order("created_at", { ascending: false });
  if (error) return null;
  const rows = (data ?? []) as Song[];
  if (rows.length === 0 && !(await hasLiveSession())) return null;
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
