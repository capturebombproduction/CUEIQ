/**
 * Is this a Web Push endpoint of a real browser push service?
 *
 * push_subscriptions.endpoint is written by the subscribing client (any signed-in
 * account), and the server POSTs to it on every notification and reminder. Without
 * this check an account could register "https://any-host/..." and have the server
 * call it (a blind SSRF). These are the push services browsers use: Google (Chrome,
 * Android, Edge on Android, Samsung, Opera, Brave), Apple (Safari / iOS home-screen
 * apps), Mozilla (Firefox), Microsoft (Edge on Windows).
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.apple.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

export function isPushServiceEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string") return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
