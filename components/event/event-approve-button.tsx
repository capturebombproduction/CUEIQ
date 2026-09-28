"use client";

import { useRouter } from "next/navigation";
import { EventStatusActions } from "@/components/overview/event-status-actions";
import type { GroupStatus } from "@/lib/types";

/**
 * อนุมัติ / ปฏิเสธ on the event page itself, for an approver, while the show is
 * waiting for one.
 *
 * The daily "มีงานรออนุมัติ" reminder links to the EVENT (app/api/cron/reminders),
 * which is the right place to check a show before approving it — but the only
 * approve control lived on the Overview board, as its tappable status pill. So the
 * reminder delivered an approver to a page with no way to do what it asked.
 * This mattered little while nothing ever reached the queue; from 2026-09-28
 * (10d2685, members' own mic numbers count) Seishin Kakumei's shows will again.
 *
 * The same EventStatusActions as the board — one write path, one notify — shown
 * as a plain button, and the page refreshes after so every badge agrees.
 */
export function EventApproveButton({
  eventId,
  eventName,
  status,
}: {
  eventId: string;
  eventName: string;
  status: GroupStatus;
}) {
  const router = useRouter();
  if (status !== "pending_review") return null;
  return (
    <EventStatusActions
      trigger="button"
      eventId={eventId}
      initialStatus={status}
      eventName={eventName}
      onChanged={() => router.refresh()}
    />
  );
}
