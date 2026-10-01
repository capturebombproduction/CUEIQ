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

/** Nothing for a band exempt from deadlines, or a show without one. `deadlineInfo`
 *  reads the clock at render, as each of the three copies it replaces did. */
export function DeadlineChip({
  deadline,
  exempt,
  note,
  className,
}: {
  deadline: string | null | undefined;
  exempt?: boolean | null;
  note?: string | null;
  className?: string;
}) {
  if (exempt) return null;
  const dl = deadlineInfo(deadline);
  if (!dl) return null;
  const Icon = ICON[dl.tone] ?? AlarmClock;
  return (
    <span className={cn("chip", TONE[dl.tone] ?? "chip-neutral", className)} title={note ?? undefined}>
      <Icon aria-hidden />
      {dl.label}
    </span>
  );
}
