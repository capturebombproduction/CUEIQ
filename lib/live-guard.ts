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
