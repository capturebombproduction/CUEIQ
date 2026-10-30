// A tiny module-level flag marking "a live show is running on THIS device and the
// sound is coming out of it" — set by Live Mode while its exit-guard is armed
// (soundOutput && show begun). It lets code OUTSIDE the Live Mode subtree (namely
// the header's Sign-out button) warn before an action that would cut the show.
//
// Live Mode's own exit-guard only intercepts <a href> clicks + beforeunload, so a
// programmatic navigation like sign-out (auth.signOut() + router.replace) slips past
// it and drops the operator to /login mid-show with no confirm. A shared flag is the
// simplest bridge across the two component trees (same client bundle → one module).
let liveShowActive = false;

/** Live Mode calls this true while its exit-guard is armed, false on teardown. */
export function setLiveShowActive(active: boolean): void {
  liveShowActive = active;
}

/** True while a sounding live show is running here — callers should confirm first. */
export function isLiveShowActive(): boolean {
  return liveShowActive;
}

// ---------------------------------------------------------------------------
// ...and in ANOTHER TAB of this browser (2026-10-30, hunt 12). The flag above is one per
// tab, so a sign-out pressed in a second tab never asked: the tab running the show lost its
// session with no warning - its heartbeat and writes failing, its run time queued for
// nobody. A session is shared by every tab, so the question has to be too. While it sounds,
// Live Mode keeps a time stamp here; a stamp stops counting after LIVE_BEACON_MAX_AGE_MS,
// so a tab that crashed cannot hold the question up for long. Web only: the desktop app has
// one window and the flag above already says it all. Storage refused = no beacon: it only
// decides whether to ask, and must never get in the way of a show or a sign-out.
// ---------------------------------------------------------------------------
const LIVE_BEACON_KEY = "cueiq:live-sounding-at";
export const LIVE_BEACON_MAX_AGE_MS = 60_000;

function inDesktopApp(): boolean {
  return !!(window as { cueiqNative?: unknown }).cueiqNative;
}

/** Live Mode, while it sounds: true stamps now (repeat well inside the max age), false clears. */
export function writeLiveShowBeacon(active: boolean): void {
  try {
    if (typeof window === "undefined" || inDesktopApp()) return;
    if (active) window.localStorage.setItem(LIVE_BEACON_KEY, String(Date.now()));
    else window.localStorage.removeItem(LIVE_BEACON_KEY);
  } catch {
    /* no storage: this browser's other tabs just are not asked */
  }
}

/** Is a tab of this browser sounding a show, by its stamp? (This tab counts too, if it is.) */
export function liveShowBeaconIsFresh(now: number = Date.now()): boolean {
  try {
    if (typeof window === "undefined" || inDesktopApp()) return false;
    const raw = window.localStorage.getItem(LIVE_BEACON_KEY);
    if (!raw) return false;
    const age = now - Number(raw);
    return age >= 0 && age < LIVE_BEACON_MAX_AGE_MS;
  } catch {
    return false;
  }
}
