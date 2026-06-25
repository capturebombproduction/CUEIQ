// Desktop Overview — mirrors app/(app)/overview/page.tsx. Replicates the server's
// data assembly client-side, then reuses OverviewClient verbatim (the festival
// schedule board). Scoped to the bands the user may view.
import { useEffect, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import {
  canApprove,
  canEditPhotoTime,
  canOpenEventDetail,
  canViewGroup,
  canViewOverview,
  isLabelWideUser,
} from "@/lib/permissions";
import { type EventRow, type Member, type StaffContact } from "@/lib/types";
import {
  OverviewClient,
  type OverviewEvent,
  type OverviewBand,
} from "@/components/overview/overview-client";
import { useWorkspace } from "~/data/workspace-context";

type SchedRow = {
  id: string;
  event_id: string;
  kind: string;
  start_time: string | null;
  end_time: string | null;
  sort_order: number;
};

type Assembled = {
  events: OverviewEvent[];
  bands: OverviewBand[];
  staff: StaffContact[];
  runOrderFestivals: string[];
};

export function Overview() {
  const { ws } = useWorkspace();
  const [data, setData] = useState<Assembled | null>(null);
  const viewable = ws ? ws.groups.filter((g) => canViewGroup(ws.perms, g.id)) : [];
  const ids = viewable.map((g) => g.id);
  const key = ids.join(",");

  useEffect(() => {
    if (!ws?.membership || ids.length === 0) {
      if (ws?.membership) setData({ events: [], bands: [], staff: [], runOrderFestivals: [] });
      return;
    }
    let alive = true;
    const tid = ws.membership.tenant_id;
    const sb = createClient();
    (async () => {
      const [evRes, schedRes, memRes, slRes, songRes, staffRes, roRes] = await Promise.all([
        sb
          .from("events")
          .select("*")
          .eq("tenant_id", tid)
          .in("group_id", ids)
          .eq("is_template", false)
          .eq("is_practice", false)
          .order("event_date", { ascending: true, nullsFirst: false }),
        sb.from("schedule_items").select("id, event_id, kind, start_time, end_time, sort_order").eq("tenant_id", tid),
        sb.from("members").select("*").eq("tenant_id", tid).in("group_id", ids).order("sort_order", { ascending: true }),
        sb.from("setlist_items").select("event_id, song_id").eq("tenant_id", tid),
        sb.from("songs").select("id, copyright_status").eq("tenant_id", tid),
        sb.from("staff_contacts").select("*").eq("tenant_id", tid).order("sort_order", { ascending: true }),
        sb.from("run_sequence").select("event_name, event_date").eq("tenant_id", tid),
      ]);

      const eventRows = (evRes.data ?? []) as EventRow[];
      const sched = (schedRes.data ?? []) as SchedRow[];
      const members = (memRes.data ?? []) as Member[];
      const slRows = (slRes.data ?? []) as { event_id: string; song_id: string | null }[];
      const songRows = (songRes.data ?? []) as { id: string; copyright_status: string }[];
      const staff = (staffRes.data ?? []) as StaffContact[];
      const roRows = (roRes.data ?? []) as { event_name: string; event_date: string | null }[];

      const runOrderFestivals = Array.from(
        new Set(roRows.map((r) => `${r.event_name}__${r.event_date ?? ""}`))
      );

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
        for (const sid of Array.from(usedByEvent.get(eventId) ?? [])) {
          const st = songStatus.get(sid);
          if (st === "pending") pending++;
          else if (st === "rejected") rejected++;
        }
        return { pending, rejected };
      };

      const groupById = new Map(viewable.map((g) => [g.id, g]));
      const rangeOf = (eventId: string, kind: string) => {
        const it = sched.find((s) => s.event_id === eventId && s.kind === kind);
        return it ? { start: it.start_time, end: it.end_time } : null;
      };
      const photoOf = (eventId: string) =>
        sched.find((s) => s.event_id === eventId && s.kind === "photo") ?? null;
      const maxSortOf = (eventId: string) =>
        sched.reduce((m, s) => (s.event_id === eventId && s.sort_order > m ? s.sort_order : m), 0);

      const events: OverviewEvent[] = eventRows.map((e) => {
        const g = groupById.get(e.group_id);
        const photoRow = photoOf(e.id);
        const cr = copyrightOf(e.id);
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
          notes: e.notes,
        };
      });

      const bands: OverviewBand[] = viewable.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        contact_name: g.contact_name,
        contact_phone: g.contact_phone,
        members: members
          .filter((m) => m.group_id === g.id)
          .map((m) => ({ id: m.id, label: m.nickname || m.name, mic_number: m.mic_number })),
      }));

      if (alive) setData({ events, bands, staff, runOrderFestivals });
    })().catch(() => alive && setData({ events: [], bands: [], staff: [], runOrderFestivals: [] }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, key]);

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }
  if (!canViewOverview(ws.perms)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ไม่มีสิทธิ์ดู Overview
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <LayoutGrid className="h-6 w-6" /> Overview
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · {viewable.length} วง
          {data ? ` · ${data.events.length} งาน` : ""}
        </p>
      </div>

      {data === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : data.bands.length === 0 ? (
        <p className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          ยังไม่มีวง — เพิ่มที่หน้า “วง”
        </p>
      ) : (
        <OverviewClient
          events={data.events}
          bands={data.bands}
          staffContacts={data.staff}
          labelName={ws.tenant.name}
          canApproveEvents={canApprove(ws.perms)}
          isLabelWide={isLabelWideUser(ws.perms)}
          canOpenDetail={canOpenEventDetail()}
          runOrderFestivals={data.runOrderFestivals}
        />
      )}
    </div>
  );
}
