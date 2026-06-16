import { Badge } from "@/components/ui/badge";
import { STATUS_META, type GroupStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: GroupStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <Badge variant={meta.variant}>
      {meta.emoji} {meta.label}
    </Badge>
  );
}
