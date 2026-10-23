// "Did the person press Sign out — or did the session just die?"
//
// auth-js emits the SAME SIGNED_OUT event for both. A deliberate sign-out comes from
// useSignOut (components/sign-out-button.tsx), after it has asked about any queued
// offline work. An involuntary one comes from auth-js itself whenever a token refresh
// is rejected for good: the refresh token was revoked elsewhere (another device's
// all-device sign-out, a password change, an admin action), or a venue's captive
// portal answered the refresh with a 4xx page instead of letting it through.
//
// The desktop wipes its offline management queue on SIGNED_OUT (desktop/src/App.tsx)
// and that wipe has no undo, so it must only follow the deliberate kind: the person
// was asked and chose to go. The involuntary kind keeps the queue — every op carries
// its owner's user id (desktop/src/data/mgmt-outbox.ts listMyOps), so nothing can
// flush as another account, and the work goes out when the same account signs back in.
//
// auth-js awaits every onAuthStateChange callback inside signOut() itself
// (_removeSession → _notifyAllSubscribers), so a flag held for the duration of the
// signOut call is what the listener sees. A counter, not a boolean, so a second tap
// that overlaps the first cannot clear it early.
let deliberate = 0;

/** Run `signOut` as a sign-out the person asked for. */
export async function duringDeliberateSignOut<T>(signOut: () => Promise<T>): Promise<T> {
  deliberate++;
  try {
    return await signOut();
  } finally {
    deliberate--;
  }
}

/** True only while a deliberate sign-out is in progress in this window. */
export function isDeliberateSignOut(): boolean {
  return deliberate > 0;
}
