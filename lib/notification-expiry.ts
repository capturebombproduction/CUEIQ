import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The notification types the reminders cron RE-SENDS every morning for as long
 * as they still apply: "โชว์พรุ่งนี้" becomes "โชว์วันนี้", a deadline inside two days
 * is re-announced, an unanswered approval is nagged again. So on any given run,
 * a row of these types from an EARLIER run is either superseded by today's copy
 * or about something that is over.
 *
 * Nothing ever cleared them. Measured 2026-09-28: seishin-ar had 48 unread, 47 of
 * them show reminders; seishin-mem 56, every one a show reminder — about shows
 * that had already happened. The bell reads "9+" forever, so the rows that do
 * need a tap (a reply to their feedback, an approval) arrive into a badge that
 * never changes and are never seen.
 */
export const DAILY_NOTIFICATION_TYPES = [
  "event_reminder",
  "event_deadline",
  "event_awaiting_approval",
] as const;

/**
 * Mark every still-unread daily notification created before `before` as read.
 * Read, not deleted: they stay in the bell's list as history, they just stop
 * counting. `before` is the run's own dedupe window start, so nothing this run
 * (or a re-run inside the window) sends is touched.
 */
export async function expireSupersededDailyNotifications(
  admin: SupabaseClient,
  { before, now }: { before: string; now: string }
): Promise<number> {
  const { data, error } = await admin
    .from("notifications")
    .update({ read_at: now })
    .in("type", [...DAILY_NOTIFICATION_TYPES])
    .is("read_at", null)
    .lt("created_at", before)
    .select("id");
  if (error) throw new Error(`expiring old reminders failed: ${error.message}`);
  return data?.length ?? 0;
}
