// Desktop festival LIVE show-caller — mirrors
// app/(app)/events/[id]/run-order/live/page.tsx. Any tenant member may WATCH; only
// approvers DRIVE (canControl + RLS). Reuses EventLiveCaller verbatim; realtime sync
// runs over the same Supabase channel the web uses, so web + desktop stay in step.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Radio } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshButton } from "@/components/refresh-button";
import { createClient } from "@/lib/supabase/client";
import { canApprove } from "@/lib/permissions";
import {
  EventLiveCaller,
  type RunSeqLive,
} from "@/components/event/event-live-caller";
import { useWorkspace } from "~/data/workspace-context";

type Assembled = { name: string; date: string | null; seqs: RunSeqLive[] };

export function RunOrderLivePage() {
  const { id } = useParams<{ id: string }>();
  const { loading, ws } = useWorkspace();
  // undefined = still loading (or the read failed, see loadError); null = no such event.
  const [data, setData] = useState<Assembled | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!ws?.membership || !id) return;
    let alive = true;
    const tid = ws.membership.tenant_id;
    const sb = createClient();
    (async () => {
      // maybeSingle (not single) so "no such event" comes back as data:null/error:null
      // and a failed read as an error — offline both look like "no row", and bouncing
      // the show-caller to a blank Overview mid-festival reads as "งานนี้ถูกลบ".
      const { data: ev, error: evErr } = await sb
        .from("events")
        .select("id, name, event_date")
        .eq("id", id)
        .maybeSingle();
      if (evErr) {
        if (alive) setLoadError(true);
        return;
      }
      if (!ev) {
        if (alive) setData(null);
        return;
      }
      let rq = sb
        .from("run_sequence")
        .select("*")
        .eq("tenant_id", tid)
        .eq("event_name", ev.name)
        .order("sort_order", { ascending: true });
      rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
      const { data: seqs, error: seqErr } = await rq;
      // An empty running order is legitimate (not built yet); a failed one is not —
      // don't hand the caller an empty board he'd read as "ยังไม่มีคิว".
      if (seqErr) {
        if (alive) setLoadError(true);
        return;
      }
      if (alive) {
        setLoadError(false);
        setData({
          name: ev.name as string,
          date: (ev.event_date as string | null) ?? null,
          seqs: (seqs ?? []) as RunSeqLive[],
        });
      }
    })().catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, id]);

  if (loading || (data === undefined && !loadError)) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>;
  }
  if (!ws?.membership) return <Navigate to="/dashboard" replace />;
  // Failed read (data never arrived): stay put with a retry — only a genuinely
  // missing event may send the caller away.
  if (data === undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
          <p>โหลดคิวงานไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
          <RefreshButton label="ลองใหม่" />
        </CardContent>
      </Card>
    );
  }
  if (!data) return <Navigate to="/overview" replace />;
  const canControl = canApprove(ws.perms);

  return (
    <div className="space-y-4">
      <Link
        to={canControl ? `/events/${id}/run-order` : `/events/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> {canControl ? "Running Order" : data.name}
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Radio className="h-6 w-6 text-primary" /> คุมคิวงาน (Live)
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.name}
          {data.date ? ` · ${data.date}` : ""} — สำหรับสตาฟคุมคิวสด ทั้งงาน
        </p>
      </div>
      <EventLiveCaller
        tenantId={ws.membership.tenant_id}
        eventName={data.name}
        eventDate={data.date}
        eventId={id!}
        initial={data.seqs}
        canControl={canControl}
      />
    </div>
  );
}
