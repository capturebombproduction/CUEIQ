"use client";

// ---------------------------------------------------------------------------
// TURNING ON WEB PUSH — the whole sequence, in one place.
//
// WHY IT MOVED HERE. On 2026-08-31 a sweep of the real data found ONE row in
// `push_subscriptions`, for one account, out of nineteen. Everything the app has
// ever pushed — an approval waiting, a reply to someone's bug report, a show
// tomorrow — has been landing on a single device. The cause was not the plumbing,
// which works: it is that the only way to switch push on is a button INSIDE the
// notification dropdown, so anyone who never opened the bell never learned the
// feature existed. Fixing that means a second place can start a subscription
// (components/notifications/push-nudge.tsx), and two copies of this sequence
// would drift — the retry below in one of them and not the other is exactly the
// kind of difference nobody notices until a shared iPad stops receiving pushes.
//
// Everything here is best-effort and reports its outcome as a value rather than
// throwing: the callers are UI, and a failure to enable a nicety must never take
// a page down.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { urlBase64ToUint8Array, vapidPublicKey } from "@/lib/push-client";

/** What this device can do about push, decided without asking the user anything. */
export type PushAvailability =
  /** No service worker, no PushManager, or no VAPID key configured. Includes the
   *  Electron app, which serves from file:// and registers no worker at all. */
  | "unsupported"
  /** Supported, permission already refused. Only the browser's own site settings
   *  can undo this — never prompt again, it is a no-op that reads as a broken button. */
  | "denied"
  /** Supported and already subscribed on this device. */
  | "on"
  /** Supported, nothing refused, not subscribed yet — the only state worth asking in. */
  | "available";

export async function pushAvailability(): Promise<PushAvailability> {
  try {
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      typeof window === "undefined" ||
      !("PushManager" in window) ||
      !vapidPublicKey()
    ) {
      return "unsupported";
    }
    if (Notification.permission === "denied") return "denied";
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "unsupported";
    const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "available";
  } catch {
    // A browser that throws while being asked what it supports does not support it.
    return "unsupported";
  }
}

export type PushEnableResult =
  | { ok: true }
  /** The user said no (or dismissed the browser prompt). Not an error. */
  | { ok: false; reason: "denied" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "failed"; message?: string };

/**
 * Ask for permission, subscribe, and persist the endpoint.
 *
 * THE RETRY IS LOAD-BEARING AND EASY TO DROP. `push_subscriptions` is keyed on the
 * endpoint, and on a shared band iPad the endpoint row can already belong to a
 * PREVIOUS user of that device — RLS then blocks the conflict-update and the upsert
 * fails for a reason that has nothing to do with this user. Dropping the browser
 * subscription mints a fresh endpoint, and the orphaned row is pruned server-side
 * on the next send (lib/push.ts treats its 403/410 as "gone").
 */
export async function enablePush(args: {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string | null;
}): Promise<PushEnableResult> {
  const key = vapidPublicKey();
  if (!key) return { ok: false, reason: "unsupported" };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };

    const reg = await navigator.serviceWorker.ready;
    const subscribe = () =>
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    const save = (sub: PushSubscription) => {
      const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
      return args.supabase.from("push_subscriptions").upsert(
        {
          user_id: args.userId,
          tenant_id: args.tenantId,
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          user_agent: navigator.userAgent.slice(0, 200),
        },
        { onConflict: "endpoint" }
      );
    };

    let sub = await subscribe();
    let { error } = await save(sub);
    if (error) {
      await sub.unsubscribe().catch(() => {});
      sub = await subscribe();
      ({ error } = await save(sub));
      if (error) return { ok: false, reason: "failed", message: error.message };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: "failed",
      message: e instanceof Error ? e.message : undefined,
    };
  }
}
