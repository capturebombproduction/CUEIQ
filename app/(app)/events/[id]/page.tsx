import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  MapPin,
  Music2,
  Pencil,
} from "lucide-react";
import { getEventBundle } from "@/lib/queries";
import { canEdit, EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { EventWorkspace } from "@/components/event/event-workspace";
import { ExportButton } from "@/components/event/export-button";

export const dynamic = "force-dynamic";

function formatDate(date: string | null): string {
  if (!date) return "ยังไม่ระบุวันที่";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function EventPage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();

  const { event } = bundle;
  const editable = canEdit(bundle.role);

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/dashboard">
            <ArrowLeft className="h-4 w-4" /> All Events
          </Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div
            className="space-y-2 border-l-4 pl-3"
            style={event.group?.color ? { borderLeftColor: event.group.color } : undefined}
          >
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
              <StatusBadge status={event.status as GroupStatus} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4" />
                {formatDate(event.event_date)}
                {event.show_start_time && (
                  <span className="tabular-nums">
                    · {shortClock(event.show_start_time)} น.
                  </span>
                )}
                {event.hard_out_time && (
                  <span className="tabular-nums">
                    (Hard Out {shortClock(event.hard_out_time)})
                  </span>
                )}
              </span>
              {event.venue && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-4 w-4" />
                  {event.venue}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Music2 className="h-4 w-4" />
                {event.group?.name ?? "—"} ·{" "}
                {EVENT_TYPES[event.event_type as EventType]?.label ??
                  event.event_type}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <ExportButton eventId={event.id} />
            {editable && (
              <Button asChild variant="outline">
                <Link href={`/events/${event.id}/edit`}>
                  <Pencil className="h-4 w-4" /> แก้ไข
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <EventWorkspace
        event={event}
        eventId={event.id}
        tenantId={event.tenant_id}
        editable={editable}
        eventType={event.event_type as EventType}
        showStartTime={event.show_start_time}
        hardOutTime={event.hard_out_time}
        schedule={bundle.schedule}
        setlist={bundle.setlist}
        micMap={bundle.micMap}
        members={bundle.members}
        songs={bundle.songs}
      />
    </div>
  );
}
