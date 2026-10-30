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
//     convenience, never load-bearing for the online path). writeCache says
//     whether the write landed, for the one caller that must know (event bundles).
import { bkkTodayKey } from "@/lib/time";

const PREFIX = "cueiq:cache:";
/** Event bundles (desktop/src/data/event-bundle.ts bundleKey) — the only entries the
 *  quota path below may drop. */
const BUNDLE_PREFIX = "event:";
/** A show this many days past keeps its bundle even when the cache is full. */
const KEEP_PAST_DAYS = 7;

export function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Write `data` under `key`. true = it is on disk now; false = it is not (the previous
 * value, if any, is still there untouched).
 *
 * A FULL cache makes room by dropping the bundles of shows more than KEEP_PAST_DAYS
 * past (Bangkok day), oldest first, trying the write again after each one. 2026-10-30,
 * hunt 10: nothing was ever dropped, and every bundle carries its band's whole song list
 * (~48 K chars for Seishin's 40 songs, against the ~5.2 M-char origin quota this shares
 * with the saved sign-in and Live's crash snapshots), so a laptop that opened every show
 * would fill within months - and from then on the NEXT show's bundle silently never
 * reached the disk (the venue door had nothing), and a held show's re-read kept last
 * week's copy. Only `event:` bundles of dated, past, non-practice shows are ever
 * dropped: never the key being written, an undated show, a practice room, or anything
 * that is not a bundle (the workspace, the song list, Live's snapshots).
 */
export function writeCache<T>(key: string, data: T): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(data);
  } catch {
    return false; // non-serializable — cache is best-effort
  }
  let res = setRaw(PREFIX + key, raw);
  if (res !== "quota") return res === "ok";
  for (const victim of droppableBundles(key)) {
    try {
      window.localStorage.removeItem(PREFIX + victim);
    } catch {
      return false;
    }
    res = setRaw(PREFIX + key, raw);
    if (res !== "quota") return res === "ok";
  }
  return false;
}

function setRaw(fullKey: string, raw: string): "ok" | "quota" | "error" {
  try {
    window.localStorage.setItem(fullKey, raw);
    return "ok";
  } catch (e) {
    return isQuotaError(e) ? "quota" : "error";
  }
}

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

/** "YYYY-MM-DD" `days` before `key`, by the calendar (no time zone involved). */
function daysBeforeKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** The bundles the quota path may drop to make room for `writing`, oldest show first.
 *  Parses every bundle — fine on this rare path, never on a normal write. */
function droppableBundles(writing: string): string[] {
  const cutoff = daysBeforeKey(bkkTodayKey(), KEEP_PAST_DAYS);
  const out: { key: string; date: string }[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const full = window.localStorage.key(i);
      if (!full || !full.startsWith(PREFIX + BUNDLE_PREFIX)) continue;
      const key = full.slice(PREFIX.length);
      if (key === writing) continue;
      let ev: { event_date?: unknown; is_practice?: unknown } | undefined;
      try {
        ev = (JSON.parse(window.localStorage.getItem(full) ?? "null") as { event?: typeof ev } | null)
          ?.event;
      } catch {
        continue; // unreadable: its date is unknown, so it is not provably old
      }
      const date = ev?.event_date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (ev?.is_practice === true || date >= cutoff) continue;
      out.push({ key, date });
    }
  } catch {
    return [];
  }
  return out
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1))
    .map((x) => x.key);
}

/** Is `key` cached? Presence probe only — no JSON.parse, so the dashboard can ask
 *  it once per upcoming event without deserializing every bundle it holds. */
export function hasCache(key: string): boolean {
  try {
    return window.localStorage.getItem(PREFIX + key) != null;
  } catch {
    return false;
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
