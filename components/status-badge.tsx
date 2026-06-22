import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_META, type GroupStatus } from "@/lib/types";

export function StatusBadge({
  status,
  className,
}: {
  status: GroupStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <Badge variant={meta.variant} className={className}>
      {meta.emoji} {meta.label}
    </Badge>
  );
}

// Solid status colour for the compact dot — mirrors each STATUS_META emoji
// (⚪🟡🟠🟢🔴) so the dot reads the same as the full badge.
const STATUS_DOT: Record<GroupStatus, string> = {
  draft: "bg-zinc-400 dark:bg-zinc-500",
  in_progress: "bg-amber-400",
  pending_review: "bg-orange-500",
  approved: "bg-green-500",
  rejected: "bg-red-500",
  overdue: "bg-red-600",
};

// A status as JUST its colour — a small dot, no text. Used where horizontal room
// is tight (the compact "รายงาน" rows) so the variable-width text badge can't
// crowd the schedule times. The full label rides along in the title tooltip.
export function StatusDot({
  status,
  className,
}: {
  status: GroupStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      className={cn(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
        STATUS_DOT[status] ?? STATUS_DOT.draft,
        className
      )}
    />
  );
}
