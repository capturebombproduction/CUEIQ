import { notFound } from "next/navigation";
import Link from "next/link";
import { Pencil, AlertTriangle } from "lucide-react";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup, canViewGroup, canApprove, canLiveEdit } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { assertReadsSucceeded } from "@/lib/read-guard";
import { eventCompleteness, performersHaveMics } from "@/lib/completeness";
import { type EventType, type GroupStatus } from "@/lib/types";
import { bkkTodayKey } from "@/lib/time";
import { callTimeOf, practiceRoomByGroup, showTimesLabel } from "@/lib/next-show";
import { Button } from "@/components/ui/button";
import { ApprovalControl } from "@/components/event/approval-control";
import { EventApproveButton } from "@/components/event/event-approve-button";
import { EventWorkspace } from "@/components/event/event-workspace";
import { type RunSeqLive } from "@/components/event/event-live-caller";
import { ExportButton } from "@/components/event/export-button";
import { EventCopyrightPanel } from "@/components/event/event-copyright-panel";
import { EventHero } from "@/components/event/event-hero";
import { EventMoreMenu } from "@/components/event/event-more-menu";
import { ShareButton } from "@/components/event/share-button";
import { RefreshButton } from "@/components/refresh-button";
import { BandSkin } from "@/components/band-skin";

export const dynamic = "force-dynamic";

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
    hasSongMics: bundle.setlist.some((s) => (s.mic_slots?.length ?? 0) > 0),
    memberMics: performersHaveMics(bundle.members, bundle.lineup),
  });

  // Editing is NOT gated by approval — whoever may edit the band (admin / Ar) can
  // change a show ANY time, in ANY status (พี่: "วงควรแก้เมื่อไหร่ก็ได้ ไม่ต้องสน
  // อนุมัติแล้ว"). Approval is now purely a staff-facing completeness/status badge,
  // not a lock. A rejected event's editor can still resubmit once it's complete.
  const canEdit = canEditGroup(ws.perms, event.group_id);
  const editable = canEdit;
  const canResubmit = canEdit && completeness.complete;

  // Reject warning — songs used in THIS event's setlist whose copyright was
  // rejected. Surfaced to the band's Ar working on the event (warn only).
  const usedSongIds = new Set(
    bundle.setlist.map((s) => s.song_id).filter(Boolean) as string[]
  );
  const callTime = callTimeOf(bundle.schedule, event.show_start_time);
  const showTimes = showTimesLabel(callTime, event.show_start_time);
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

  const canRunLive = canLiveEdit(ws.perms);
  // Same rule as the dashboard ticket: Live Mode leads for an admin, for anyone
  // with no band practice (label staff proofing a show), and on the show's own day.
  const leadLive =
    canRunLive || ws.perms.tenantRole === "label_staff" || event.event_date === bkkTodayKey();

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
  // Which room the hero's practice button opens: the band's, found exactly as the
  // dashboard ticket finds it (lib/next-show practiceRoomByGroup), so "ซ้อมตามเซ็ต"
  // leads to the same room from both screens. Asked only when that button shows.
  // Best-effort, and deliberately OUTSIDE the read guard below: a failed read here
  // claims nothing about the band's rooms — the button then opens the Training list
  // and says so ("ห้องซ้อม", components/event/event-hero.tsx), true either way.
  const bestEffort = <T,>(q: PromiseLike<T> | null) =>
    q ? Promise.resolve(q).catch(() => null) : null;
  const [runSeqRes, roomRes, roomRunRes] = await Promise.all([
    roq,
    bestEffort(
      leadLive || !event.group_id
        ? null
        : supabase
            .from("events")
            .select("id, group_id")
            .eq("tenant_id", event.tenant_id)
            .eq("group_id", event.group_id)
            .eq("is_practice", true)
            .order("created_at", { ascending: false })
    ),
    bestEffort(
      leadLive || !event.group_id
        ? null
        : supabase
            .from("practice_runs")
            .select("event_id, group_id")
            .eq("group_id", event.group_id)
            .order("created_at", { ascending: false })
            .limit(50)
    ),
  ]);
  const practiceRoom =
    roomRes && !roomRes.error && roomRunRes && !roomRunRes.error
      ? practiceRoomByGroup(
          (roomRes.data ?? []) as { id: string; group_id: string }[],
          (roomRunRes.data ?? []) as { event_id: string | null; group_id: string }[]
        )[event.group_id]
      : undefined;
  // getEventBundle above is all-or-none about the six child reads for exactly this
  // reason; this seventh read was left outside the rule. A FAILED READ IS NOT A
  // ZERO COUNT (lib/read-guard.ts) — and here it is worse than a wrong count,
  // because the empty array says NOTHING AT ALL. components/event/event-summary.tsx
  // gates the card on `runSeq.length > 0`, so a failed select does not render "วงนี้
  // ยังไม่ถูกผูกกับลำดับในคิวงาน"; it makes the whole EventRunStatusCard VANISH from
  // the band's event page, on a festival day, with no message and nothing to retry.
  // And because the card never mounts, its own self-healing refetch never arms
  // either — the SUBSCRIBED / visibilitychange / online handlers in
  // components/event/event-run-status.tsx live INSIDE it, so the one component that
  // would have recovered on the next reconnect is the component that was removed.
  // Failing the page here is the only outcome the members watching a countdown can
  // actually see.
  assertReadsSucceeded("EventPage", { "ลำดับคิวงาน": runSeqRes });
  const runSeq = (runSeqRes.data ?? []) as RunSeqLive[];

  return (
    <div className="space-y-3">
      <BandSkin hex={event.group?.skin} />
      {/* No "← All Events" here any more: the header's "‹ EVENTS" is the way back on
          a phone, and the inline nav from lg up (spec §G.3) — two back links on one
          screen read as two different places. */}
      <EventHero
        event={event}
        callTime={callTime}
        leadLive={leadLive}
        practiceRoomHref={practiceRoom ? `/events/${practiceRoom}/practice` : null}
        statusActions={
          <>
            {canApprove(ws.perms) && (
              <EventApproveButton
                eventId={event.id}
                eventName={event.name}
                status={event.status as GroupStatus}
              />
            )}
            <ApprovalControl
              eventId={event.id}
              status={event.status as GroupStatus}
              canResubmit={canResubmit}
            />
          </>
        }
        more={
          <EventMoreMenu eventName={event.name}>
            {editable && (
              <Button asChild variant="secondary">
                <Link href={`/events/${event.id}/edit`}>
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
            <ExportButton eventId={event.id} groupId={event.group_id} variant="secondary" />
            <RefreshButton variant="secondary" label="โหลดข้อมูลล่าสุด" />
          </EventMoreMenu>
        }
      >
        {/* "นัด 11:20 · ขึ้นเวที 13:20" in one piece for a screen reader — the tiles
            above set the same numbers apart for the eye (lib/next-show.ts). */}
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
