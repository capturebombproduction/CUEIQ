import webpush from "web-push";
import { isPushServiceEndpoint } from "@/lib/push-endpoint";

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

/**
 * How long a push service may hold a push for a phone that is off or offline before it
 * drops it (2026-10-27 hunt 6). web-push's own default is 4 WEEKS: a phone switched off
 * through the show woke up the next day to "🔴 งานเริ่มแล้ว (Live)" and "📅 โชว์วันนี้"
 * for a show that was already over, and a tap opened a finished board. The bell keeps
 * every row as history anyway - a late push only misleads.
 */
export const PUSH_TTL_SECONDS = {
  /** "the show just went live": worth nothing once the show is well under way */
  live: 3 * 3600,
  /** the morning reminders cron: re-sent every day it still applies */
  reminder: 12 * 3600,
  /** approvals, a rejected song, a feedback reply: still worth a buzz for a few days */
  default: 3 * 24 * 3600,
} as const;

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
  payload: object,
  ttlSeconds: number = PUSH_TTL_SECONDS.default
): Promise<"ok" | "gone" | "error"> {
  // Only ever a real push service (lib/push-endpoint.ts): the endpoint is the client's
  // to write. Not "gone" - a host this list does not know yet is never pruned.
  if (!isPushServiceEndpoint(sub.endpoint)) return "error";
  ensure();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: ttlSeconds }
    );
    return "ok";
  } catch (e: unknown) {
    const code = (e as { statusCode?: number })?.statusCode;
    return code === 404 || code === 410 ? "gone" : "error";
  }
}
