import webpush from "web-push";

/**
 * Server-only Web Push helper. VAPID keys identify our app to the browser push
 * services (FCM / Apple Push) — free, no third-party service. When the keys are
 * absent push degrades to a no-op (in-app notifications still work).
 */
export function vapidConfigured(): boolean {
  return !!(
    process.env.VAPID_PRIVATE_KEY?.trim() &&
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  );
}

let ready = false;
function ensure() {
  if (ready) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT?.trim() || "mailto:admin@cueiq.local",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim()
  );
  ready = true;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send one push. Returns "gone" for an expired/unsubscribed endpoint (404/410)
 * only, so the caller can prune it; "error" for anything else (never throws).
 *
 * 403/400 must NEVER be treated as "gone". Those codes are provider-side, not
 * per-endpoint: Apple returns 403 for BadJwtToken / ExpiredProviderToken (e.g.
 * server clock skew, or a rejected sub claim — see the mailto fallback above,
 * which is non-routable and can itself be the rejected claim), and FCM returns
 * 400 for a malformed Authorization header. Both fire identically for every
 * subscription in the database at once, so mapping them to "gone" would let a
 * single VAPID misconfiguration prune every user's push subscription in one
 * cron run, forcing everyone to re-enable push by hand. Key-rotation pruning
 * is instead handled per-device via applicationServerKey comparison in
 * components/notifications/notification-bell.tsx, which is the correct place
 * for it. Surface 403/400 as "error" so the failure is logged, not swallowed.
 */
export async function sendPush(
  sub: PushSub,
  payload: object
): Promise<"ok" | "gone" | "error"> {
  ensure();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "ok";
  } catch (e: unknown) {
    const code = (e as { statusCode?: number })?.statusCode;
    return code === 404 || code === 410 ? "gone" : "error";
  }
}
