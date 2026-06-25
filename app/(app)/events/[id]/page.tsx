import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  MapPin,
  Music2,
  Pencil,
  AlarmClock,
  AlertTriangle,
} from "lucide-react";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup, canViewGroup, canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { eventCompleteness } from "@/lib/completeness";
import { EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock, deadlineInfo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { ApprovalControl } from "@/components/event/approval-control";
import { EventWorkspace } from "@/components/event/event-workspace";
import { type RunSeqLive } from "@/components/event/event-live-caller";
import { ExportButton } from "@/components/event/export-button";
import { PrepareDeviceButton } from "@/components/event/prepare-device-button";
import { EventCopyrightPanel } from "@/components/event/event-copyright-panel";
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
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await getEventBundle(id);
  if (!bundle) notFound();

  const { event } = bundle;
  const ws = await getWorkspace();
  // Per-band scope: a band-tier user (Ar / member) may open ONLY their own band's
  // events; label-wide users (admin / ceo / label_staff) may open any. RLS is
  // tenant-wide, so this guard — not the DB — stops one band from reaching
  // another's event by URL. label_staff lands here read-only to proof a show.
  if (!canViewGroup(ws.perms, event.group_id)) notFound();

  // Completeness drives the auto-transition (draft ↔ pending_review) + the
  // "ยังขาด…" panel on the Summary. Single source of truth = lib/completeness.
  const completeness = eventCompleteness({
    event,
    schedule: bundle.schedule,
    setlist: bundle.setlist,
    micCount: bundle.micMap.length,
  });

  // Approved = LOCKED: read-only for everyone until reverted. The band's editor
  // (admin / Ar) or an approver may revert it to pending_review to make changes;
  // a rejected event's editor may resubmit once it's complete again.
  const canEdit = canEditGroup(ws.perms, event.group_id);
  const editable = canEdit && event.status !== "approved";
  const canRevert = canEdit || canApprove(ws.perms);
  const canResubmit = canEdit && completeness.complete;

  // Resolve which audio files this event plays so the device can pre-cache them.
  const songAudio: SongAudioMap = Object.fromEntries(
    bundle.songs.map((s) => [
      s.id,
      { path: s.audio_path ?? null, name: s.audio_name ?? null },
    ])
  );
  const audioTargets = resolveAudioTargets(bundle.setlist, songAudio);

  // Reject warning — songs used in THIS event's setlist whose copyright was
  // rejected. Surfaced to the band's Ar working on the event (warn only).
  const usedSongIds = new Set(
    bundle.setlist.map((s) => s.song_id).filter(Boolean) as string[]
  );
  const rejectedSongs = bundle.songs.filter(
    (s) => usedSongIds.has(s.id) && s.copyright_status === "rejected"
  );

  // Approver-only (admin / label_staff) copyright triage for the library songs
  // used in this event — lets staff clear/reject right here while proofing the
  // show, since label_staff no longer sees the full song library.
  const setlistLibrarySongs = bundle.songs
    .filter((s) => usedSongIds.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      copyright_status: s.copyright_status,
    }));
  const showCopyrightPanel =
    canApprove(ws.perms) && setlistLibrarySongs.length > 0;

  // Pull this festival's (same name + date) running order so the band can WATCH
  // its own slot status live on its event page (read-only EventRunStatusCard).
  // Staff build & drive the order from Overview — not from here anymore.
  const supabase = await createClient();
  let roq = supabase
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", event.tenant_id)
    .eq("event_name", event.name)
    .order("sort_order", { ascending: true });
  roq = event.event_date
    ? roq.eq("event_date", event.event_date)
    : roq.is("event_date", null);
  const { data: runSeqData } = await roq;
  const runSeq = (runSeqData ?? []) as RunSeqLive[];

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
            <ApprovalControl
              eventId={event.id}
              status={event.status as GroupStatus}
              canRevert={canRevert}
              canResubmit={canResubmit}
            />
          </div>
        </div>
      </div>

      {rejectedSongs.length > 0 && (
        <div className="no-print rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            เพลงในงานนี้ถูกปฏิเสธลิขสิทธิ์ ({rejectedSongs.length})
          </div>
          <ul className="ml-7 mt-1.5 list-disc space-y-0.5 text-sm text-muted-foreground">
            {rejectedSongs.map((s) => (
              <li key={s.id}>
                <span className="font-medium text-foreground">{s.title}</span> —
                ควรเปลี่ยนเพลงหรือตรวจสอบลิขสิทธิ์ก่อนแสดง
              </li>
            ))}
          </ul>
        </div>
      )}

      {showCopyrightPanel && <EventCopyrightPanel songs={setlistLibrarySongs} />}

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
        runSeq={runSeq}
      />
    </div>
  );
}
