import { AlarmClock, Hourglass, OctagonAlert } from "lucide-react";
import { deadlineInfo, type DeadlineTone } from "@/lib/time";
import { cn } from "@/lib/utils";

// The setlist deadline as a chip (spec §E.4: icon + word, tokens only). It replaces
// three hand-kept DEADLINE_* maps (the dashboard card, the event header and its
// desktop copy) whose raw palette put white on orange-500 — 2.8:1 — on the chip
// that says "ด่วน!". URGENT is the solid amber plate (its own dark ink) and SOON
// the amber tint — fill vs tint, so the step still reads with both in amber.
// Overdue is the band-independent alarm plate, never the band's destructive: on a
// red band that token is shifted off red (lib/skin.ts) and would read violet.
const TONE: Record<DeadlineTone, string> = {
  overdue: "chip-alarm",
  urgent: "bg-warning text-warning-foreground",
  soon: "chip-warning",
  ok: "chip-neutral",
};
const ICON = { overdue: OctagonAlert, urgent: Hourglass, soon: Hourglass, ok: AlarmClock } as const;

/**
 * The deadline as the app says it, or null when there is nothing to say: a band exempt from
 * deadlines, a show without one, or an APPROVED show - its setlist is done, so the deadline
 * is met (2026-10-27, hunt 9): an approved show whose deadline had passed wore the red
 * "เลยกำหนดแล้ว" on its page, the dashboard and Overview, while the reminder cron
 * (app/api/cron/reminders) already left approved shows alone. The one rule for the chip below
 * and Overview's own cell.
 */
export function shownDeadline(
  deadline: string | null | undefined,
  show: { exempt?: boolean | null; status: string | null | undefined }
): ReturnType<typeof deadlineInfo> {
  if (show.exempt || show.status === "approved") return null;
  return deadlineInfo(deadline);
}

/** `status` is required on purpose: a call site that forgets it would bring the alarm back
 *  on approved shows. `deadlineInfo` reads the clock at render, as each of the three copies
 *  it replaces did. */
export function DeadlineChip({
  deadline,
  exempt,
  status,
  note,
  className,
}: {
  deadline: string | null | undefined;
  exempt?: boolean | null;
  status: string | null | undefined;
  note?: string | null;
  className?: string;
}) {
  const dl = shownDeadline(deadline, { exempt, status });
  if (!dl) return null;
  const Icon = ICON[dl.tone] ?? AlarmClock;
  return (
    <span className={cn("chip", TONE[dl.tone] ?? "chip-neutral", className)} title={note ?? undefined}>
      <Icon aria-hidden />
      {dl.label}
    </span>
  );
}
