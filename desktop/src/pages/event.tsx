// Desktop event detail — mirrors app/(app)/events/[id]/page.tsx (read view).
// Reuses EventWorkspace verbatim (Summary tab + the code-split editors), driven
// by a client-fetched bundle — plus the same action bar the web has: Export
// Excel, resubmit-after-rejection, and the copyright warning/triage. Those were
// deferred at M2 and stayed deferred long after the desktop became the copy that
// actually goes to the venue, which is exactly where the run sheet is needed.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, MapPin, Music2, Pencil, AlarmClock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { EventWorkspace } from "@/components/event/event-workspace";
import { ApprovalControl } from "@/components/event/approval-control";
import { ExportButton } from "@/components/event/export-button";
import { EventCopyrightPanel } from "@/components/event/event-copyright-panel";
import type { RunSeqLive } from "@/components/event/event-live-caller";
import { createClient } from "@/lib/supabase/client";
import { canApprove, canEditGroup, canViewGroup } from "@/lib/permissions";
import { eventCompleteness } from "@/lib/completeness";
import { EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock, deadlineInfo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { isOffline, readCache, writeCache } from "~/data/cache";
import { hasLiveSession } from "@/lib/auth-session";
import { onRouterRefresh } from "~/shims/next-navigation";
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
  const [runSeq, setRunSeq] = useState<RunSeqLive[]>([]);

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

  // router.refresh() from the reused components (the auto draft↔pending write,
  // and switching to the Summary tab) has to re-read the bundle here — there is
  // no server render to bust. Re-loads IN PLACE: no loading flash, and a reload
  // that fails or comes back empty (offline, or nothing cached yet) keeps what
  // is already on screen instead of blanking to "ไม่พบงานนี้".
  const reloading = useRef(false);
  const reloadQueued = useRef(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const reload = () => {
      // refresh() can fire on every trip to Summary, so run one load at a time —
      // but never DROP one: the last refresh is the one whose data gets printed
      // / exported. Queue it and re-run once the in-flight load settles.
      if (reloading.current) {
        reloadQueued.current = true;
        return;
      }
      reloading.current = true;
      reloadQueued.current = false;
      loadEventBundle(id)
        .then((bundle) => {
          if (alive && bundle) setState({ loading: false, bundle });
        })
        .catch(() => {})
        .finally(() => {
          reloading.current = false;
          if (alive && reloadQueued.current) reload();
        });
    };
    const off = onRouterRefresh(reload);
    return () => {
      alive = false;
      reloadQueued.current = false;
      off();
    };
  }, [id]);

  // This festival's running order, so the band sees its own live-queue card here
  // too ("อีก 12 นาที ถึงคิวเรา" / "กำลังเล่น" / the drift the caller is pushing) —
  // the desktop app is the one that actually goes to the venue. Same query the web
  // event page runs (app/(app)/events/[id]/page.tsx): tenant + event name + date.
  // Read only from a bundle that belongs to THIS route id — on a navigation the
  // previous event's bundle is still in state for one render, and fetching from it
  // would key another festival's order to this event.
  const seqEvent =
    state.bundle && state.bundle.event.id === id ? state.bundle.event : null;
  const seqTenantId = seqEvent?.tenant_id ?? null;
  const seqName = seqEvent?.name ?? null;
  const seqDate = seqEvent?.event_date ?? null;
  useEffect(() => {
    if (!id || !seqTenantId || !seqName) {
      // Nothing to show yet (still loading, or a different event) — never keep the
      // previous event's queue on screen.
      setRunSeq((prev) => (prev.length ? [] : prev));
      return;
    }
    let alive = true;
    const cacheKey = `runseq:${id}`;
    // Cached alongside the event bundle so the card survives a venue cold-boot;
    // any failure degrades to the last known order, or to no card at all.
    const fallback = () => {
      if (alive) setRunSeq(readCache<RunSeqLive[]>(cacheKey) ?? []);
    };
    if (isOffline()) {
      fallback();
    } else {
      (async () => {
        const sb = createClient();
        let q = sb
          .from("run_sequence")
          .select("*")
          .eq("tenant_id", seqTenantId)
          .eq("event_name", seqName)
          .order("sort_order", { ascending: true });
        q = seqDate ? q.eq("event_date", seqDate) : q.is("event_date", null);
        const { data, error } = await q;
        if (!alive) return;
        // postgrest reports a dead network as { data: null, error } instead of
        // throwing — caching that would wipe a good cached order with an empty one.
        if (error || !data) {
          fallback();
          return;
        }
        const rows = data as RunSeqLive[];
        // An empty answer can also mean the request went out as anon (a token
        // refresh that failed a moment ago — see hasLiveSession), which RLS
        // returns as no rows and no error. Keep the cached order rather than
        // overwrite it with a blank one we can't vouch for.
        if (rows.length === 0 && !(await hasLiveSession())) {
          fallback();
          return;
        }
        if (!alive) return;
        setRunSeq(rows);
        writeCache(cacheKey, rows);
      })().catch(fallback);
    }
    return () => {
      alive = false;
    };
  }, [id, seqTenantId, seqName, seqDate]);

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
  const canResubmit = canEdit && completeness.complete;

  // Songs in THIS setlist whose copyright was rejected — a warning for the band's
  // Ar, and the approver's triage list. Same derivation as the web event page.
  const usedSongIds = new Set(
    bundle.setlist.map((s) => s.song_id).filter(Boolean) as string[]
  );
  const rejectedSongs = bundle.songs.filter(
    (s) => usedSongIds.has(s.id) && s.copyright_status === "rejected"
  );
  const setlistLibrarySongs = bundle.songs
    .filter((s) => usedSongIds.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      copyright_status: s.copyright_status,
    }));
  const showCopyrightPanel =
    !!ws && canApprove(ws.perms) && setlistLibrarySongs.length > 0;

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

          {/* Same action bar as the web event page. The desktop is the copy that
              goes to the VENUE, and it could not produce the run sheet venue staff
              hold, nor resubmit a rejected show — both lived only in the browser. */}
          <div className="flex flex-wrap items-center gap-2">
            <ExportButton
              eventId={event.id}
              groupId={event.group_id}
              // From the bundle already on screen (and on disk), so the run sheet
              // can be produced with no network — at the venue, which is where it
              // is actually wanted.
              data={{
                event,
                schedule: bundle.schedule,
                setlist: bundle.setlist,
                micMap: bundle.micMap,
                members: bundle.members,
                lineup: bundle.lineup,
              }}
            />
            {editable && (
              <Button asChild variant="outline">
                <Link to={`/events/${event.id}/edit`}>
                  <Pencil className="h-4 w-4" /> แก้ไข
                </Link>
              </Button>
            )}
            <ApprovalControl
              eventId={event.id}
              status={event.status as GroupStatus}
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
