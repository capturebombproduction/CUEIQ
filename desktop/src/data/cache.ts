// Tiny localStorage read-cache for desktop MANAGEMENT data (workspace, events
// list, event bundles). The desktop pages read these straight from Supabase, so
// with no network the app shows nothing. This caches the last successful read so
// the app can boot offline and display last-known data.
//
// Design rules (matches the rest of the offline suite — additive + online-safe):
//   • ONLINE behavior is unchanged: loaders always hit Supabase and write-through
//     to the cache. The cache is only ever READ as a fallback.
//   • Offline reads are gated on a live auth session by the callers, so a
//     logged-out device never shows a previous user's cached data.
//   • Best-effort: any quota / serialization error is swallowed (cache is a
//     convenience, never load-bearing for the online path).
const PREFIX = "cueiq:cache:";

export function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    /* quota exceeded / non-serializable — cache is best-effort */
  }
}

/** Cache keys (sans prefix) that start with `keyPrefix` — e.g. every "event:" bundle. */
export function readCacheKeys(keyPrefix: string): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX + keyPrefix)) out.push(k.slice(PREFIX.length));
    }
    return out;
  } catch {
    return [];
  }
}

/** Wipe every cached management entry (e.g. on sign-out). */
export function clearCache(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/** Browser is currently offline (no network). */
export const isOffline = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;
