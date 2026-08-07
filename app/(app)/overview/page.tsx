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
import { eventCompleteness, type CompletenessSetlistItem } from "@/lib/completeness";
import {
  type EventRow,
  type Member,
  type StaffContact,
  type ScheduleItem,
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

type SlRow = {
  event_id: string;
  song_id: string | null;
  kind: string;
  // Selected ONLY so this board applies the same "song row with no name" rule as the
  // event Summary. Before the round-10 repair pass the boards mapped rows down to
  // `{ kind }`, so an unnamed song row showed ยังขาด 1 on its own event page (which
  // auto-reverts the show to Draft) while Overview — the board the label actually
  // runs the day off — showed nothing left to do. See lib/completeness.ts.
  title: string;
  mic_slots: { mic: string; member: string }[] | null;
};

/** One festival key part (name + date) — see the run_sequence read below. */
type RoRow = { event_name: string; event_date: string | null };

/** A postgrest-shaped result, so callers keep the error handling they already had. */
type Res<T> = { data: T[] | null; error: { message: string } | null };

// PostgREST caps every response at max-rows (1000 on Supabase) and truncates
// SILENTLY — .error stays null, so a partial read renders as if it were everything
// the bands entered: blank stage/booth times, "ยังขาด" on an event that IS complete,
// copyright counts of 0, a date header with no "คุมคิว (Live)" button. This board
// mixes several tenant-sized reads, so it hits that cap long before anything looks
// wrong. app/api/cron/backup/route.ts already pages around the same trap; the rule
// here is the same — end ONLY on an EMPTY page (a server cap smaller than PAGE_SIZE
// must never read as "that was the last page") and return an error rather than a
// silently short list. MAX_PAGES only exists so a misbehaving server can't spin.
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
// The event ids ride in the request URL (?event_id=in.(…)), ~37 chars per uuid, so
// they go out in chunks that keep the URL well inside any proxy's header limit. More
// events just means more (still fully paged) round-trips — never a dropped id.
const ID_CHUNK = 80;

async function readPaged<T>(
  label: string,
  select: (
    from: number,
    to: number
  ) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
    count?: number | null;
  }>
): Promise<Res<T>> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error, count } = await select(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    // Every read below asks for an exact count, so we know when we have the whole
    // set from the FIRST response. Ending only on an empty page (the shape this
    // had) is just as correct but costs one extra round trip PER READ, every time
    // this board is opened — with eight reads across two phases that is real
    // latency on the page the label lives in. The empty-page rule stays as the
    // fallback for a response that carries no count, and as the no-progress stop.
    if (typeof count === "number" && rows.length >= count) return { data: rows, error: null };
    if (batch.length === 0) return { data: rows, error: null };
  }
  return {
    data: null,
    error: { message: `${label}: over ${MAX_PAGES * PAGE_SIZE} rows` },
  };
}

/** Same, for a child table read per event: chunk the ids, page inside each chunk. */
async function readForEvents<T>(
  label: string,
  eventIds: string[],
  select: (
    ids: string[],
    from: number,
    to: number
  ) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
    count?: number | null;
  }>
): Promise<Res<T>> {
  const rows: T[] = [];
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const chunk = eventIds.slice(i, i + ID_CHUNK);
    const res = await readPaged<T>(label, (from, to) => select(chunk, from, to));
    if (res.error) return res;
    rows.push(...(res.data ?? []));
  }
  return { data: rows, error: null };
}

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

  // Two phases: the per-event children are SCOPED to the events actually on the
  // board, so the event ids have to land first. Everything within a phase still
  // runs in parallel. Every read is paged (see readPaged) — a tenant-wide select
  // that quietly stops at 1000 rows is the failure this shape exists to prevent.
  const [evRes, memRes, songRes, staffRes] = await Promise.all([
    readPaged<EventRow>("events", (from, to) =>
      supabase
        .from("events")
        .select("*", { count: "exact" })
        .eq("tenant_id", tid)
        .in("group_id", viewableGroupIds) // only bands this user may view
        .eq("is_template", false) // templates are not real shows
        .eq("is_practice", false) // practice rooms aren't real shows
        .order("event_date", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true }) // total order — paging must not skip/repeat
        .range(from, to)
    ),
    readPaged<Member>("members", (from, to) =>
      supabase
        .from("members")
        .select("*", { count: "exact" })
        .eq("tenant_id", tid)
        .in("group_id", viewableGroupIds) // rosters for visible bands only
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    ),
    readPaged<{ id: string; copyright_status: string }>("songs", (from, to) =>
      supabase
        .from("songs")
        .select("id, copyright_status", { count: "exact" })
        .eq("tenant_id", tid)
        .order("id", { ascending: true })
        .range(from, to)
    ),
    readPaged<StaffContact>("staff_contacts", (from, to) =>
      supabase
        .from("staff_contacts")
        .select("*", { count: "exact" })
        .eq("tenant_id", tid)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ]);

  const eventRows = (evRes.data ?? []) as EventRow[];
  const members = (memRes.data ?? []) as Member[];
  const songRows = (songRes.data ?? []) as { id: string; copyright_status: string }[];
  const staff = (staffRes.data ?? []) as StaffContact[];

  const eventIds = eventRows.map((e) => e.id);
  // run_sequence keys on the festival (name + date), not on an event id, so it's
  // bounded by the dates the board actually shows instead of by event. An undated
  // event keys on "name__", which only a null-date row can answer — so that bucket
  // is read only when such an event is on the board.
  const evDates = eventRows
    .map((e) => e.event_date)
    .filter((d): d is string => !!d)
    .sort();
  const dateLo = evDates[0];
  const dateHi = evDates[evDates.length - 1];
  const hasUndated = eventRows.some((e) => !e.event_date);
  const readRunOrders = async (): Promise<Res<RoRow>> => {
    const base = () =>
      supabase
        .from("run_sequence")
        .select("event_name, event_date", { count: "exact" })
        .eq("tenant_id", tid);
    const parts: Res<RoRow>[] = [];
    if (dateLo) {
      parts.push(
        await readPaged<RoRow>("run_sequence", (from, to) =>
          base()
            .gte("event_date", dateLo)
            .lte("event_date", dateHi)
            .order("id", { ascending: true })
            .range(from, to)
        )
      );
    }
    if (hasUndated) {
      parts.push(
        await readPaged<RoRow>("run_sequence", (from, to) =>
          base().is("event_date", null).order("id", { ascending: true }).range(from, to)
        )
      );
    }
    const failed = parts.find((p) => p.error);
    return failed ?? { data: parts.flatMap((p) => p.data ?? []), error: null };
  };

  const [schedRes, slRes, roRes, micRes] = await Promise.all([
    readForEvents<SchedRow>("schedule_items", eventIds, (ids, from, to) =>
      supabase
        .from("schedule_items")
        .select("id, event_id, kind, start_time, end_time, sort_order", {
          count: "exact",
        })
        .eq("tenant_id", tid)
        .in("event_id", ids)
        .order("id", { ascending: true })
        .range(from, to)
    ),
    readForEvents<SlRow>("setlist_items", eventIds, (ids, from, to) =>
      supabase
        .from("setlist_items")
        .select("event_id, song_id, kind, title, mic_slots", { count: "exact" })
        .eq("tenant_id", tid)
        .in("event_id", ids)
        .order("id", { ascending: true })
        .range(from, to)
    ),
    // Which festivals (name + date) already have a running order — drives the
    // "คุมคิว (Live)" entry on each date header (staff build & run from Overview now).
    readRunOrders(),
    // Mic assignments — counted per event for the readiness (completeness) badge.
    readForEvents<{ event_id: string }>("mic_assignments", eventIds, (ids, from, to) =>
      supabase
        .from("mic_assignments")
        .select("event_id", { count: "exact" })
        .eq("tenant_id", tid)
        .in("event_id", ids)
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ]);

  const sched = (schedRes.data ?? []) as SchedRow[];
  const slRows = (slRes.data ?? []) as SlRow[];
  const roRows = (roRes.data ?? []) as RoRow[];
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
  // `title` is OPTIONAL here and stays that way all the way into eventCompleteness.
  // Do NOT put a `?? ""` back on the push below. lib/completeness.ts:118-121 makes
  // `title: undefined` load-bearing — it means "the caller did not tell us", which
  // reads LENIENT, while "" means "a human left this row blank", which flags the
  // event. Coercing the first into the second is the exact reading that comment
  // calls catastrophic: the day someone trims this select for payload size, or a
  // response shape changes, every song row of every event flips to
  // "⚠ ขาด 1 · เพลงใน Setlist ที่ยังไม่ได้ใส่ชื่อ" on the board the label runs the
  // day off — and every pending_review event auto-reverts to Draft on its event page
  // (components/event/event-workspace.tsx). It is not a type error and not a missing
  // column, so nothing else would catch it. The column is `text not null default ''`
  // today (0001_init.sql:93) and is in the select, so this changes no current
  // behaviour; it restores the failure mode the guard was designed to have.
  const setlistByEvent = new Map<string, { kind: string; title?: string }[]>();
  const songMicByEvent = new Map<string, boolean>(); // any setlist song with mic_slots
  for (const r of slRows) {
    const arr = setlistByEvent.get(r.event_id) ?? [];
    arr.push({ kind: r.kind, title: r.title });
    setlistByEvent.set(r.event_id, arr);
    if ((r.mic_slots?.length ?? 0) > 0) songMicByEvent.set(r.event_id, true);
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
      // Cast to the gate's OWN input type, which declares `title` optional. Casting
      // to Pick<SetlistItem,"kind"|"title"> (title: string) asserted a title always
      // exists and would have hidden a trimmed select from tsc.
      setlist: (setlistByEvent.get(e.id) ?? []).map((s) => ({
        kind: s.kind,
        title: s.title,
      })) as CompletenessSetlistItem[],
      micCount: micByEvent.get(e.id) ?? 0,
      hasSongMics: songMicByEvent.get(e.id) ?? false,
    });

  const groupById = new Map(viewableGroups.map((g) => [g.id, g]));
  // Stage/Booth carry a start→end window for the staff schedule; missing end is
  // fine (rendered as a single time). Photo stays start-only (inline-editable).
  // ALL slots of a kind, earliest first. A band can play twice and work several
  // booth shifts in one day; taking only the first row (what this did) hid the rest
  // from the board the day is actually run off. [0] stays the sort/filter key.
  const rangesOf = (eventId: string, kind: string) =>
    sched
      .filter((s) => s.event_id === eventId && s.kind === kind)
      .sort((a, b) => (a.start_time ?? "￿").localeCompare(b.start_time ?? "￿"))
      .map((it) => ({ start: it.start_time, end: it.end_time }));
  const rangeOf = (eventId: string, kind: string) => rangesOf(eventId, kind)[0] ?? null;
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
      stageMore: rangesOf(e.id, "stage").slice(1),
      boothMore: rangesOf(e.id, "booth").slice(1),
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
