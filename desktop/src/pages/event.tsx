// Desktop event detail — mirrors app/(app)/events/[id]/page.tsx (read view).
// Reuses EventWorkspace verbatim (Summary tab + the code-split editors), driven
// by a client-fetched bundle — plus the same action bar the web has: Export
// Excel, resubmit-after-rejection, and the copyright warning/triage. Those were
// deferred at M2 and stayed deferred long after the desktop became the copy that
// actually goes to the venue, which is exactly where the run sheet is needed.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Play, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EventWorkspace } from "@/components/event/event-workspace";
import { ApprovalControl } from "@/components/event/approval-control";
import { ExportButton } from "@/components/event/export-button";
import { EventCopyrightPanel } from "@/components/event/event-copyright-panel";
import { EventHero } from "@/components/event/event-hero";
import { EventMoreMenu } from "@/components/event/event-more-menu";
import { ShareButton } from "@/components/event/share-button";
import { RefreshButton } from "@/components/refresh-button";
import type { RunSeqLive } from "@/components/event/event-live-caller";
import { createClient } from "@/lib/supabase/client";
import { canApprove, canEditGroup, canLiveEdit, canViewGroup } from "@/lib/permissions";
import { eventCompleteness, performersHaveMics } from "@/lib/completeness";
import { type EventType, type GroupStatus } from "@/lib/types";
import { bkkTodayKey } from "@/lib/time";
import { callTimeOf, showTimesLabel } from "@/lib/next-show";
import { loadEventBundle, loadEventBundleStatus, type EventBundle } from "~/data/event-bundle";
import { isOffline, readCache, writeCache } from "~/data/cache";
import { hasLiveSession } from "@/lib/auth-session";
import { onRouterRefresh } from "~/shims/next-navigation";
import { useWorkspace } from "~/data/workspace-context";

/** Shown when the load came back with NOTHING because the server could not be
 *  reached — as opposed to because the show is gone or is not this account's.
 *
 *  Those two used to render the same dead end, so an Ar opening a show at load-in
 *  on a congested venue hotspot was told the show did not exist, with one button
 *  back to a dashboard that would tell them the same thing. Same shape as
 *  ~/components/shell.tsx's ShellFallback and App.tsx's BootScreen, deliberately:
 *  say plainly that this is the network, offer ลองใหม่, and keep Quick Show one
 *  click away — when the wifi is the problem, running the show from this machine's
 *  own files is the operator's real next move. */
function EventUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto w-full max-w-sm space-y-6 py-16">
      <div className="space-y-1 text-center">
        <p className="text-muted-foreground">โหลดข้อมูลงานไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา</p>
        {/* Same instruction the dashboard's readiness badge gives, word for word —
            see components/event/events-list.tsx. */}
        <p className="text-xs text-muted-foreground">
          เครื่องนี้ยังไม่ได้เก็บข้อมูลงานนี้ไว้ — กด ‘เตรียมทุกงานที่จะถึง’ ที่หน้างานทั้งหมด หรือเปิดงานนี้ตอนออนไลน์ 1 ครั้ง
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          ลองใหม่
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างานทั้งหมด
          </Link>
        </Button>
      </div>
      {/* Same Quick Show entry as the boot + shell fallbacks (see ~/pages/Login). */}
      <Link
        to="/my-show"
        className="group flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3 shadow-sm transition-colors hover:border-primary/70 hover:bg-primary/10"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors group-hover:bg-primary/25">
          <Play className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-bold text-primary">Quick Show</span>
          <span className="block text-xs text-muted-foreground">
            โหมดโชว์เดี่ยว — เปิดเพลง+จับเวลาจากเครื่องนี้ ไม่ต้องเข้าสู่ระบบ
          </span>
        </span>
      </Link>
    </div>
  );
}

export function EventPage() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const [state, setState] = useState<{
    loading: boolean;
    bundle: EventBundle | null;
    /** The load never got a trustworthy answer — see EventBundleLoad.unreachable.
     *  Only consulted when `bundle` is null; a cached bundle renders either way. */
    unreachable: boolean;
  }>({ loading: true, bundle: null, unreachable: false });
  const [runSeq, setRunSeq] = useState<RunSeqLive[]>([]);
  /** Bumped by the ลองใหม่ button to re-run the load below. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ loading: true, bundle: null, unreachable: false });
    loadEventBundleStatus(id)
      .then(
        ({ bundle, unreachable }) =>
          alive && setState({ loading: false, bundle, unreachable })
      )
      .catch(() => alive && setState({ loading: false, bundle: null, unreachable: true }));
    return () => {
      alive = false;
    };
  }, [id, attempt]);

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
          if (alive && bundle) setState({ loading: false, bundle, unreachable: false });
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
  // Nothing to show because nothing answered. NOT the same screen as the one below:
  // this one can be retried, and saying "ไม่พบงานนี้" here would be a lie about a
  // show that exists and is merely on the far side of a bad hotspot.
  if (!bundle && state.unreachable) {
    return <EventUnreachable onRetry={() => setAttempt((n) => n + 1)} />;
  }
  // Not found, or a band-tier user reaching another band's event by URL — and also
  // where a show this device DELETED OFFLINE lands. That one reaches no server either,
  // but it is not `unreachable`: the answer is local and final, so the dead end is the
  // truthful screen and a ลองใหม่ would only promise a retry that changes nothing.
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
    memberMics: performersHaveMics(bundle.members, bundle.lineup),
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
  const callTime = callTimeOf(bundle.schedule, event.show_start_time);
  const showTimes = showTimesLabel(callTime, event.show_start_time);
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

  const canRunLive = !!ws && canLiveEdit(ws.perms);
  // Same rule as the web event page and the dashboard ticket.
  const leadLive =
    canRunLive || ws?.perms.tenantRole === "label_staff" || event.event_date === bkkTodayKey();

  return (
    <div className="space-y-3">
      {/* The same hero as the web event page. The header's inline nav is the way
          back to Events here (no "← All Events" row — spec §G.3). The desktop is the
          copy that goes to the VENUE, so the ⋯ keeps Excel (from the bundle on
          disk), resubmitting a rejected show and the share link within reach. */}
      <EventHero
        event={event}
        callTime={callTime}
        leadLive={leadLive}
        // The web page finds the band's room with two reads this machine does not
        // cache (and the desktop ticket does not make either), so the practice
        // button opens the Training list here — labelled ห้องซ้อม, for where it goes.
        practiceRoomHref={null}
        statusActions={
          <ApprovalControl
            eventId={event.id}
            status={event.status as GroupStatus}
            canResubmit={canResubmit}
          />
        }
        more={
          <EventMoreMenu eventName={event.name}>
            {editable && (
              <Button asChild variant="secondary">
                <Link to={`/events/${event.id}/edit`}>
                  <Pencil aria-hidden /> แก้ไขรายละเอียดงาน
                </Link>
              </Button>
            )}
            {editable && (
              <ShareButton
                eventId={event.id}
                initialToken={event.share_token}
                initialExpiresAt={event.share_expires_at}
                variant="secondary"
              />
            )}
            <ExportButton
              eventId={event.id}
              groupId={event.group_id}
              variant="secondary"
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
            <RefreshButton variant="secondary" label="โหลดข้อมูลล่าสุด" />
          </EventMoreMenu>
        }
      >
        {/* Same words as the web page (lib/next-show.ts), whole, for a screen reader. */}
        {showTimes && <p className="sr-only">{showTimes}</p>}
      </EventHero>

      {rejectedSongs.length > 0 && (
        <div className="no-print slab p-3 shadow-[inset_3px_0_0_hsl(var(--destructive)),inset_0_0_0_1px_hsl(var(--border))]">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <AlertTriangle aria-hidden className="h-5 w-5 shrink-0 text-destructive" />
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
        canRunLive={canRunLive}
        liveInHero
        // Under the run sheet, on Summary (spec G.3) — not between the hero and the
        // tabs, where 12 songs' rows pushed the tabs off a phone's first screen.
        summaryFooter={
          showCopyrightPanel ? <EventCopyrightPanel songs={setlistLibrarySongs} /> : null
        }
      />
    </div>
  );
}
