import { createClient } from "@/lib/supabase/client";

/**
 * Release this device's Web Push subscription on sign-out. Call BEFORE
 * auth.signOut() — deleting the push_subscriptions row needs the still-
 * authenticated session (RLS: user_id = auth.uid()). On a shared device the
 * endpoint would otherwise stay bound to the previous user: their pushes keep
 * arriving on the device and the next user's enable-push hits an RLS conflict.
 *
 * Best-effort by design: it must never block or fail a sign-out. The bell also
 * unsubscribes on the SIGNED_OUT auth event as a safety net (browser-side only
 * — by then the session is gone, so the row is left for server-side pruning).
 */
export async function cleanupPushOnSignOut(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    // row first (needs auth), then the browser subscription itself
    const { error } = await createClient()
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", sub.endpoint);
    // Only release the browser subscription if the row actually went away. If the
    // delete failed (dead network at the venue, RLS), unsubscribing would kill push
    // on this device while the row lives on — the bell still shows "เปิดแล้ว" and
    // reminders silently stop, and the sign-out itself may not even go through.
    // Leaving both in place keeps them consistent; the bell's SIGNED_OUT listener
    // still unsubscribes once the sign-out really completes.
    if (!error) await sub.unsubscribe();
  } catch {
    /* best-effort — sign-out proceeds regardless */
  }
}
