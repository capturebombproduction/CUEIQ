// Desktop festival Running Order builder — mirrors
// app/(app)/events/[id]/run-order/page.tsx. Replicates the server's data assembly
// client-side, then reuses RunOrderBuilder verbatim. Approvers only (RLS enforces
// the writes too). Edits sync to the web via the shared Supabase.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ListOrdered, Radio } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { canApprove } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import {
  RunOrderBuilder,
  type RunSequence,
  type RunBandEvent,
} from "@/components/event/run-order-builder";
import { useWorkspace } from "~/data/workspace-context";

type Assembled = {
  name: string;
  date: string | null;
  seqs: RunSequence[];
  bandEvents: RunBandEvent[];
};

export function RunOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { loading, ws } = useWorkspace();
  const [data, setData] = useState<Assembled | null | undefined>(undefined);

  useEffect(() => {
    if (!ws?.membership || !id) return;
    let alive = true;
    const tid = ws.membership.tenant_id;
    const groupName = new Map(ws.groups.map((g) => [g.id, g.name]));
    const sb = createClient();
    (async () => {
      const { data: ev } = await sb
        .from("events")
        .select("id, name, event_date")
        .eq("id", id)
        .single();
      if (!ev) {
        if (alive) setData(null);
        return;
      }
      let fq = sb
        .from("events")
        .select("id, group_id")
        .eq("tenant_id", tid)
        .eq("name", ev.name)
        .eq("is_template", false)
        .eq("is_practice", false);
      fq = ev.event_date ? fq.eq("event_date", ev.event_date) : fq.is("event_date", null);
      const { data: festEvents } = await fq;
      const ids = (festEvents ?? []).map((e) => e.id);
      // Ordered by start_time so a band's slots arrive in the order it actually plays —
      // the builder seeds the running order straight off this list.
      const { data: stages } = ids.length
        ? await sb
            .from("schedule_items")
            .select("event_id, start_time, end_time")
            .eq("tenant_id", tid)
            .eq("kind", "stage")
            .in("event_id", ids)
            .order("start_time", { ascending: true })
        : { data: [] as { event_id: string; start_time: string | null; end_time: string | null }[] };
      // A band can hold SEVERAL stage slots on one festival day — mig 0036 caps only
      // 'photo' at one row per event. A Map keyed by event_id kept whichever row the
      // query returned last, so a band booked twice reached the running order once
      // (often at the wrong time) and the live caller never announced the other slot.
      // Key a LIST instead (same assembly as the web page).
      const stagesBy = new Map<string, { start_time: string | null; end_time: string | null }[]>();
      for (const s of stages ?? []) {
        const slot = s as { start_time: string | null; end_time: string | null };
        const list = stagesBy.get(s.event_id as string);
        if (list) list.push(slot);
        else stagesBy.set(s.event_id as string, [slot]);
      }
      // One entry PER STAGE SLOT, all carrying the band's event id (= linked_event_id).
      // An event with no stage row still gets one slot-less entry so the builder's link
      // dropdown can still reach it.
      const bandEvents: RunBandEvent[] = (festEvents ?? []).flatMap((e) => {
        const base = {
          id: e.id as string,
          group_name: groupName.get(e.group_id as string) ?? "—",
        };
        const slots = stagesBy.get(e.id as string);
        return slots?.length
          ? slots.map((s) => ({ ...base, stage_start: s.start_time, stage_end: s.end_time }))
          : [{ ...base, stage_start: null, stage_end: null }];
      });
      let rq = sb
        .from("run_sequence")
        .select("*")
        .eq("tenant_id", tid)
        .eq("event_name", ev.name)
        .order("sort_order", { ascending: true });
      rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
      const { data: seqs } = await rq;
      if (alive)
        setData({
          name: ev.name as string,
          date: (ev.event_date as string | null) ?? null,
          seqs: (seqs ?? []) as RunSequence[],
          bandEvents,
        });
    })().catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, id]);

  if (loading || data === undefined) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>;
  }
  if (!ws?.membership || !canApprove(ws.perms)) return <Navigate to="/dashboard" replace />;
  if (!data) return <Navigate to="/overview" replace />;

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/events/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← {data.name}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ListOrdered className="h-6 w-6" /> Running Order
          </h1>
          <Button asChild>
            <Link to={`/events/${id}/run-order/live`}>
              <Radio className="h-4 w-4" /> คุมคิว (Live)
            </Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.name}
          {data.date ? ` · ${data.date}` : ""} — ลำดับงานทั้งงาน (สำหรับสตาฟคุมคิว)
        </p>
      </div>
      <RunOrderBuilder
        tenantId={ws.membership.tenant_id}
        eventName={data.name}
        eventDate={data.date}
        initial={data.seqs}
        bandEvents={data.bandEvents}
      />
    </div>
  );
}
