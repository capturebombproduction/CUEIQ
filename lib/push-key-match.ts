/**
 * A PushSubscription is permanently bound to the applicationServerKey (VAPID
 * public key) it was minted with. After the server rotates its VAPID keys, an
 * old subscription still exists in the browser and `Notification.permission`
 * still reads "granted" — but push can never be delivered to it again. This
 * compares a live subscription's key against the server's current one so the
 * caller can tell "actually on" from "looks on, silently dead".
 *
 * `current` is `null` on browsers that don't report
 * `PushSubscriptionOptions.applicationServerKey` back (older Safari). Treat
 * that as "can't verify" rather than a mismatch — unsubscribing a still-valid
 * subscription would be worse than leaving a stale one undetected.
 */
export function applicationServerKeyMatches(
  current: ArrayBuffer | null,
  expected: Uint8Array
): boolean {
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== expected.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== expected[i]) return false;
  }
  return true;
}
