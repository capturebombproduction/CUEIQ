import { redirect } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { JoinDemo } from "@/components/join-demo";
import {
  canApprove,
  canEditPhotoTime,
  isLabelWideUser,
  canOpenEventDetail,
  canViewOverview,
  canViewGroup,
} from "@/lib/permissions";
import {
  OverviewClient,
  type OverviewEvent,
  type OverviewBand,
} from "@/components/overview/overview-client";
import { eventCompleteness } from "@/lib/completeness";
import {
  type EventRow,
  type Member,
  type StaffContact,
  type ScheduleItem,
  type SetlistItem,
} from "@/lib/types";

export const dynamic = "force-dynamic";

type SchedRow = {
  id: string;
  event_id: string;
  kind: string;
  start_time: string | null;
  end_time: string | null;
  sort_order: number;
};

export default async function OverviewPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) return <JoinDemo />;
  // Anyone in at least one band may open Overview; a user with no band and no
  // label-wide standing has nothing to see, so bounce them like /admin does.
  if (!canViewOverview(ws.perms)) redirect("/dashboard");
  const tid = ws.membership.tenant_id;

  // Scope to the bands this user may view. RLS is tenant-wide (every member can
  // read every band/event), so a band-only Ar/member is narrowed HERE: label-wide
  // → all bands, otherwise only their own. Drives both the events query and the
  // band list, so each band sees only its own schedule.
  const viewableGroups = ws.groups.filter((g) => canViewGroup(ws.perms, g.id));
  const viewableGroupIds = viewableGroups.map((g) => g.id);
  // Approve/reject is for approvers (admin / label_staff); others see status only.
  const canApproveEvents = canApprove(ws.perms);
  const supabase = await createClient();

  const [evRes, schedRes, memRes, slRes, songRes, staffRes, roRes, micRes] =
    await Promise.all([
    supabase
      .from("events")
      .select("*")
      .eq("tenant_id", tid)
      .in("group_id", viewableGroupIds) // only bands this user may view
      .eq("is_template", false) // templates are not real shows
      .eq("is_practice", false) // practice rooms aren't real shows
      .order("event_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("schedule_items")
      .select("id, event_id, kind, start_time, end_time, sort_order")
      .eq("tenant_id", tid),
    supabase
      .from("members")
      .select("*")
      .eq("tenant_id", tid)
      .in("group_id", viewableGroupIds) // rosters for visible bands only
      .order("sort_order", { ascending: true }),
    supabase
      .from("setlist_items")
      .select("event_id, song_id, kind")
      .eq("tenant_id", tid),
    supabase
      .from("songs")
      .select("id, copyright_status")
      .eq("tenant_id", tid),
    supabase
      .from("staff_contacts")
      .select("*")
      .eq("tenant_id", tid)
      .order("sort_order", { ascending: true }),
    // Which festivals (name + date) already have a running order — drives the
    // "คุมคิว (Live)" entry on each date header (staff build & run from Overview now).
    supabase
      .from("run_sequence")
      .select("event_name, event_date")
      .eq("tenant_id", tid),
    // Mic assignments — counted per event for the readiness (completeness) badge.
    supabase.from("mic_assignments").select("event_id").eq("tenant_id", tid),
  ]);

  const eventRows = (evRes.data ?? []) as EventRow[];
  const sched = (schedRes.data ?? []) as SchedRow[];
  const members = (memRes.data ?? []) as Member[];
  const slRows = (slRes.data ?? []) as {
    event_id: string;
    song_id: string | null;
    kind: string;
  }[];
  const songRows = (songRes.data ?? []) as { id: string; copyright_status: string }[];
  const staff = (staffRes.data ?? []) as StaffContact[];
  const roRows = (roRes.data ?? []) as {
    event_name: string;
    event_date: string | null;
  }[];
  const micRows = (micRes.data ?? []) as { event_id: string }[];
  // Distinct festival keys (name__date) that have a running order. Same key the
  // client rebuilds from each event's name + date.
  const runOrderFestivals = Array.from(
    new Set(roRows.map((r) => `${r.event_name}__${r.event_date ?? ""}`))
  );

  // Per-event copyright rollup — count the distinct library songs used in each
  // event's setlist that are pending / rejected, so approvers spot issues here.
  const songStatus = new Map(songRows.map((s) => [s.id, s.copyright_status]));
  const usedByEvent = new Map<string, Set<string>>();
  for (const r of slRows) {
    if (!r.song_id) continue;
    const set = usedByEvent.get(r.event_id) ?? new Set<string>();
    set.add(r.song_id);
    usedByEvent.set(r.event_id, set);
  }
  const copyrightOf = (eventId: string) => {
    let pending = 0;
    let rejected = 0;
    for (const id of Array.from(usedByEvent.get(eventId) ?? [])) {
      const st = songStatus.get(id);
      if (st === "pending") pending++;
      else if (st === "rejected") rejected++;
    }
    return { pending, rejected };
  };

  // Per-event prep maps for the readiness (completeness) badge — reuse the single
  // source of truth eventCompleteness() so the Overview agrees with the event Summary.
  const micByEvent = new Map<string, number>();
  for (const m of micRows) micByEvent.set(m.event_id, (micByEvent.get(m.event_id) ?? 0) + 1);
  const setlistByEvent = new Map<string, { kind: string }[]>();
  for (const r of slRows) {
    const arr = setlistByEvent.get(r.event_id) ?? [];
    arr.push({ kind: r.kind });
    setlistByEvent.set(r.event_id, arr);
  }
  const schedByEvent = new Map<string, SchedRow[]>();
  for (const s of sched) {
    const arr = schedByEvent.get(s.event_id) ?? [];
    arr.push(s);
    schedByEvent.set(s.event_id, arr);
  }
  const completenessOf = (e: EventRow) =>
    eventCompleteness({
      event: e,
      schedule: (schedByEvent.get(e.id) ?? []).map((s) => ({
        kind: s.kind,
        start_time: s.start_time,
      })) as Pick<ScheduleItem, "kind" | "start_time">[],
      setlist: (setlistByEvent.get(e.id) ?? []).map((s) => ({
        kind: s.kind,
      })) as Pick<SetlistItem, "kind">[],
      micCount: micByEvent.get(e.id) ?? 0,
    });

  const groupById = new Map(viewableGroups.map((g) => [g.id, g]));
  // Stage/Booth carry a start→end window for the staff schedule; missing end is
  // fine (rendered as a single time). Photo stays start-only (inline-editable).
  const rangeOf = (eventId: string, kind: string) => {
    const it = sched.find((s) => s.event_id === eventId && s.kind === kind);
    return it ? { start: it.start_time, end: it.end_time } : null;
  };
  const photoOf = (eventId: string) =>
    sched.find((s) => s.event_id === eventId && s.kind === "photo") ?? null;
  const maxSortOf = (eventId: string) =>
    sched.reduce(
      (m, s) => (s.event_id === eventId && s.sort_order > m ? s.sort_order : m),
      0
    );

  const events: OverviewEvent[] = eventRows.map((e) => {
    const g = groupById.get(e.group_id);
    const photoRow = photoOf(e.id);
    const cr = copyrightOf(e.id);
    const comp = completenessOf(e);
    return {
      id: e.id,
      name: e.name,
      group_id: e.group_id,
      group_name: g?.name ?? "—",
      group_color: g?.color ?? null,
      exempt_from_deadline: g?.exempt_from_deadline ?? false,
      event_date: e.event_date,
      status: e.status,
      deadline: e.deadline,
      stage: rangeOf(e.id, "stage"),
      booth: rangeOf(e.id, "booth"),
      photo: photoRow?.start_time ?? null,
      photoEnd: photoRow?.end_time ?? null,
      tenant_id: e.tenant_id,
      canEditPhoto: g ? canEditPhotoTime(ws.perms, e.group_id, g.self_photo) : false,
      photoItemId: photoRow?.id ?? null,
      photoSortOrder: maxSortOf(e.id) + 1,
      copyrightPending: cr.pending,
      copyrightRejected: cr.rejected,
      incomplete: comp.missing.length,
      missingLabels: comp.missing.map((m) => m.label),
      notes: e.notes,
    };
  });

  const bands: OverviewBand[] = viewableGroups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    contact_name: g.contact_name,
    contact_phone: g.contact_phone,
    members: members
      .filter((m) => m.group_id === g.id)
      .map((m) => ({
        id: m.id,
        label: m.nickname || m.name,
        mic_number: m.mic_number,
      })),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <LayoutGrid className="h-6 w-6" /> Overview
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · {viewableGroups.length} วง · {events.length} งาน
        </p>
      </div>

      {bands.length === 0 ? (
        <p className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          ยังไม่มีวง — เพิ่มที่หน้า “วง”
        </p>
      ) : (
        <OverviewClient
          events={events}
          bands={bands}
          staffContacts={staff}
          labelName={ws.tenant.name}
          canApproveEvents={canApproveEvents}
          isLabelWide={isLabelWideUser(ws.perms)}
          canOpenDetail={canOpenEventDetail()}
          runOrderFestivals={runOrderFestivals}
        />
      )}
    </div>
  );
}
