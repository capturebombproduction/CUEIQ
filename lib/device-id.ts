// A stable, random identifier for THIS device/browser, persisted in localStorage.
// It's the basis of offline-first authority: which device is the Audio Host
// (device-lock) and which is the Show Main (device-claim) is tracked by deviceId,
// so a device keeps its role across reloads and the cloud can attribute show-run
// changes to a device when it syncs. NOT security-sensitive — it names a device,
// not a user. See docs/offline-first-plan.md §3 / §7.

const ID_KEY = "cueiq:deviceId";
const NAME_KEY = "cueiq:deviceName";

let cached: string | null = null;

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * This device's stable id, creating + persisting one on first use. SSR-safe:
 * returns a throwaway id when there's no localStorage (it stabilises on the client,
 * which is the only place authority decisions are made).
 */
export function getDeviceId(): string {
  if (cached) return cached;
  if (typeof window === "undefined") return randomId();
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(ID_KEY, id);
    }
    cached = id;
    return id;
  } catch {
    cached = randomId();
    return cached;
  }
}

/** Last 4 alphanumerics, upper-cased — for compact chips like "MAIN · A1B2". */
export function shortDeviceId(id: string): string {
  const s = id.replace(/[^a-z0-9]/gi, "");
  return (s.slice(-4) || s).toUpperCase();
}

/** A friendly device name the user can set (e.g. "iPad หลังเวที"), stored locally
 *  and shown in hand-off / authority UI. null = not named. */
export function getDeviceName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function setDeviceName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    const t = name.trim();
    if (t) localStorage.setItem(NAME_KEY, t);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    /* ignore */
  }
}

/** Friendly name if set, otherwise a short id label — what UIs should display. */
export function deviceLabel(): string {
  return getDeviceName() || shortDeviceId(getDeviceId());
}
