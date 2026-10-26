import { vapidConfigured, sendPush, PUSH_TTL_SECONDS } from "@/lib/push";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Fan a single Web Push payload out to every device of the given users, pruning
 * any expired endpoints. No-op (returns 0) when VAPID isn't configured. Used by
 * the reminder cron; /api/notify has its own inline copy tied to its row insert.
 *
 * THROWS when the push_subscriptions read fails (2026-10-25): answering 0 made a
 * broken read look like "nobody has a device", so the cron never reported it.
 */
export async function pushToUsers(
  admin: Admin,
  userIds: string[],
  payload: { title: string; body: string; link: string },
  ttlSeconds: number = PUSH_TTL_SECONDS.default
): Promise<number> {
  if (!vapidConfigured() || userIds.length === 0) return 0;
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (error) throw new Error(`push_subscriptions: ${error.message}`);
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    (subs ?? []).map(async (s) => {
      const res = await sendPush(
        { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
        payload,
        ttlSeconds
      );
      if (res === "ok") sent++;
      else if (res === "gone") dead.push(s.id as string);
    })
  );
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return sent;
}
