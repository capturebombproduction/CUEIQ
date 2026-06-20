import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  MapPin,
  Music2,
  Pencil,
  AlarmClock,
} from "lucide-react";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup, canOpenEventDetail } from "@/lib/permissions";
import { EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock, deadlineInfo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { EventWorkspace } from "@/components/event/event-workspace";
import { ExportButton } from "@/components/event/export-button";
import { PrepareDeviceButton } from "@/components/event/prepare-device-button";
import { BandSkin } from "@/components/band-skin";

export const dynamic = "force-dynamic";

const DEADLINE_BADGE: Record<string, string> = {
  overdue: "bg-destructive text-destructive-foreground",
  urgent: "bg-orange-500 text-white",
  soon: "bg-amber-400 text-black",
  ok: "bg-muted text-muted-foreground",
};

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

  // label_staff works from /overview only — the full event workspace is off-limits.
  const ws = await getWorkspace();
  if (!canOpenEventDetail(ws.perms)) redirect("/overview");

  const { event } = bundle;
  const editable = canEditGroup(ws.perms, event.group_id);

  // Resolve which audio files this event plays so the device can pre-cache them.
  const songAudio: SongAudioMap = Object.fromEntries(
    bundle.songs.map((s) => [
      s.id,
      { path: s.audio_path ?? null, name: s.audio_name ?? null },
    ])
  );
  const audioTargets = resolveAudioTargets(bundle.setlist, songAudio);

  return (
    <div className="space-y-6">
      <BandSkin hex={event.group?.skin} />
      <div className="no-print">
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
              {!event.group?.exempt_from_deadline &&
                (() => {
                  const dl = deadlineInfo(event.deadline);
                  if (!dl) return null;
                  return (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
                        DEADLINE_BADGE[dl.tone]
                      )}
                      title={event.deadline_note ?? undefined}
                    >
                      <AlarmClock className="h-3.5 w-3.5" /> {dl.label}
                    </span>
                  );
                })()}
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

          <div className="flex flex-wrap items-center gap-2">
            <PrepareDeviceButton eventId={event.id} targets={audioTargets} />
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
        lineup={bundle.lineup}
      />
    </div>
  );
}
