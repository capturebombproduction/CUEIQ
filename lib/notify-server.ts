import { vapidConfigured, sendPush } from "@/lib/push";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Fan a single Web Push payload out to every device of the given users, pruning
 * any expired endpoints. No-op (returns 0) when VAPID isn't configured. Used by
 * the reminder cron; /api/notify has its own inline copy tied to its row insert.
 */
export async function pushToUsers(
  admin: Admin,
  userIds: string[],
  payload: { title: string; body: string; link: string }
): Promise<number> {
  if (!vapidConfigured() || userIds.length === 0) return 0;
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    (subs ?? []).map(async (s) => {
      const res = await sendPush(
        { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
        payload
      );
      if (res === "ok") sent++;
      else if (res === "gone") dead.push(s.id as string);
    })
  );
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return sent;
}
