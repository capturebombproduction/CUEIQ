// Desktop event detail — mirrors app/(app)/events/[id]/page.tsx (read view).
// Reuses EventWorkspace verbatim (Summary tab + the code-split editors), driven
// by a client-fetched bundle. Heavier peripherals (export / approval / device
// prep / festival run-order) are deferred to a later milestone.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, MapPin, Music2, Pencil, AlarmClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { EventWorkspace } from "@/components/event/event-workspace";
import { canEditGroup, canViewGroup } from "@/lib/permissions";
import { eventCompleteness } from "@/lib/completeness";
import { EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock, deadlineInfo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { useWorkspace } from "~/data/workspace-context";

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
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function EventPage() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const [state, setState] = useState<{ loading: boolean; bundle: EventBundle | null }>({
    loading: true,
    bundle: null,
  });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ loading: true, bundle: null });
    loadEventBundle(id)
      .then((bundle) => alive && setState({ loading: false, bundle }))
      .catch(() => alive && setState({ loading: false, bundle: null }));
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดงาน…</p>;
  }

  const bundle = state.bundle;
  // Not found, or a band-tier user reaching another band's event by URL.
  if (!bundle || (ws && !canViewGroup(ws.perms, bundle.event.group_id))) {
    return (
      <div className="space-y-4 py-16 text-center">
        <p className="text-muted-foreground">ไม่พบงานนี้ หรือไม่มีสิทธิ์เข้าถึง</p>
        <Button asChild variant="outline">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างานทั้งหมด
          </Link>
        </Button>
      </div>
    );
  }

  const { event } = bundle;
  const completeness = eventCompleteness({
    event,
    schedule: bundle.schedule,
    setlist: bundle.setlist,
    micCount: bundle.micMap.length,
    hasSongMics: bundle.setlist.some((s) => (s.mic_slots?.length ?? 0) > 0),
  });
  const canEdit = !!ws && canEditGroup(ws.perms, event.group_id);
  // Editing is not gated by approval — edit any time, any status (approval is just a
  // staff completeness badge). Matches the web event page.
  const editable = canEdit;

  return (
    <div className="space-y-6">
      <div className="no-print">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/dashboard">
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
                  <span className="tabular-nums">· {shortClock(event.show_start_time)} น.</span>
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
                {EVENT_TYPES[event.event_type as EventType]?.label ?? event.event_type}
              </span>
            </div>
          </div>

          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline">
                <Link to={`/events/${event.id}/edit`}>
                  <Pencil className="h-4 w-4" /> แก้ไข
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>

      <EventWorkspace
        event={event}
        eventId={event.id}
        tenantId={event.tenant_id}
        editable={editable}
        completeness={completeness}
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
