// Preflight "Show Readiness Check" — gathers the on-device signals that decide
// whether THIS device can safely run a show, ESPECIALLY offline (worst case: no
// net the whole gig). Are all of the setlist's audio files cached at the current
// version? Is storage pinned so the browser won't evict them before the show? Is
// there free space, charge, and a network link? Pure data-gathering (browser APIs
// only) so the UI component (show-readiness-check.tsx) just renders the result.
//
// Builds on the existing readiness primitive (lib/audio-prefetch.ts getReadiness)
// and the same persist() / estimate() the dashboard already uses — this just
// pulls them together into one preflight, the foundation of offline-first (audio
// must be present before anything else matters; see docs/offline-first-plan.md §11-B).

import { getReadiness, type PrefetchTarget, type Readiness } from "./audio-prefetch";

export interface StorageInfo {
  persisted: boolean | null; // null = unknown/unsupported; true = browser won't evict
  usage: number | null; // bytes used by this origin (all stores)
  quota: number | null; // bytes available to this origin
  free: number | null; // quota - usage, clamped ≥ 0
}

export interface BatteryInfo {
  level: number | null; // 0..1, or null if unknown
  charging: boolean | null;
  supported: boolean; // false on browsers without the Battery API (e.g. iOS Safari)
}

export interface ShowReadiness {
  audio: Readiness;
  storage: StorageInfo;
  battery: BatteryInfo;
  online: boolean;
}

/** persisted + quota/usage in one read. Best-effort: any unsupported field stays null. */
export async function getStorageInfo(): Promise<StorageInfo> {
  const out: StorageInfo = { persisted: null, usage: null, quota: null, free: null };
  if (typeof navigator === "undefined" || !navigator.storage) return out;
  try {
    if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch {
    /* unsupported */
  }
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.usage = est.usage ?? null;
      out.quota = est.quota ?? null;
      if (out.usage != null && out.quota != null) {
        out.free = Math.max(0, out.quota - out.usage);
      }
    }
  } catch {
    /* unsupported */
  }
  return out;
}

/**
 * Ask the browser to PIN this origin's storage so it won't evict the cached show
 * audio when space runs low. Returns the resulting persisted state (true/false),
 * or null if unsupported. Already-persisted short-circuits to true.
 */
export async function requestPersist(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

interface BatteryManager {
  level: number;
  charging: boolean;
}

/** Battery level/charging if the browser exposes it (Chromium does; iOS Safari
 *  doesn't → supported:false, treated as "unknown, don't block"). */
export async function getBatteryInfo(): Promise<BatteryInfo> {
  if (typeof navigator === "undefined") {
    return { level: null, charging: null, supported: false };
  }
  const getBattery = (
    navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  ).getBattery;
  if (typeof getBattery !== "function") {
    return { level: null, charging: null, supported: false };
  }
  try {
    const b = await getBattery.call(navigator);
    return {
      level: typeof b.level === "number" ? b.level : null,
      charging: !!b.charging,
      supported: true,
    };
  } catch {
    return { level: null, charging: null, supported: false };
  }
}

/** All preflight signals for one event's audio targets, gathered in parallel. */
export async function getShowReadiness(
  eventId: string,
  targets: PrefetchTarget[]
): Promise<ShowReadiness> {
  const [audio, storage, battery] = await Promise.all([
    getReadiness(eventId, targets),
    getStorageInfo(),
    getBatteryInfo(),
  ]);
  return {
    audio,
    storage,
    battery,
    online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
  };
}

/** Bytes → compact human label (shared by the readiness UI). */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
