import {
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleX,
  Hourglass,
  OctagonAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_META, type GroupStatus } from "@/lib/types";

/**
 * Chip tone + icon per status (spec §E.4). Status is icon + word, never colour alone
 * and never an emoji in UI chrome: an emoji is a third colour system that ignores the
 * theme, and ⚪ / 🟡 / 🟠 are not tellable apart at chip size. STATUS_META keeps its
 * emoji for text-only places (push and notification copy); its `variant` predates
 * the info and alarm tones, so the tone lives here.
 */
export const STATUS_CHIP: Record<GroupStatus, { variant: NonNullable<BadgeProps["variant"]>; Icon: LucideIcon }> = {
  draft: { variant: "secondary", Icon: CircleDashed },
  in_progress: { variant: "info", Icon: CircleDotDashed },
  pending_review: { variant: "warning", Icon: Hourglass },
  approved: { variant: "success", Icon: CircleCheck },
  rejected: { variant: "destructive", Icon: CircleX },
  overdue: { variant: "alarm", Icon: OctagonAlert },
};

/** The status icon alone, for a menu row or a select option that already says the word. */
export function StatusIcon({ status, className }: { status: GroupStatus; className?: string }) {
  const { Icon } = Object.prototype.hasOwnProperty.call(STATUS_CHIP, status)
    ? STATUS_CHIP[status]
    : STATUS_CHIP.draft;
  return <Icon aria-hidden className={className} />;
}

export function StatusBadge({
  status,
  className,
}: {
  status: GroupStatus;
  className?: string;
}) {
  // An unknown status from the DB renders as a draft rather than crashing the page.
  const known: GroupStatus = Object.prototype.hasOwnProperty.call(STATUS_CHIP, status)
    ? status
    : "draft";
  const { variant, Icon } = STATUS_CHIP[known];
  return (
    <Badge variant={variant} className={cn("en", className)} data-status={known}>
      <Icon aria-hidden />
      {STATUS_META[known].label}
    </Badge>
  );
}
