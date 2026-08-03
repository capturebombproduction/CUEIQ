// Desktop festival LIVE show-caller — mirrors
// app/(app)/events/[id]/run-order/live/page.tsx. Any tenant member may WATCH; only
// approvers DRIVE (canControl + RLS). Reuses EventLiveCaller verbatim; realtime sync
// runs over the same Supabase channel the web uses, so web + desktop stay in step.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Radio } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshButton } from "@/components/refresh-button";
import { canApprove } from "@/lib/permissions";
import { EventLiveCaller } from "@/components/event/event-live-caller";
import { useWorkspace } from "~/data/workspace-context";
import { loadRunOrderLive, type RunOrderLive } from "~/data/run-order";

export function RunOrderLivePage() {
  const { id } = useParams<{ id: string }>();
  const { loading, ws } = useWorkspace();
  // undefined = still loading (or the read failed, see loadError); null = no such event.
  const [data, setData] = useState<RunOrderLive | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  // Served from this device's disk, i.e. the board may have moved on since.
  const [offlineCopy, setOfflineCopy] = useState(false);

  useEffect(() => {
    if (!ws?.membership || !id) return;
    let alive = true;
    loadRunOrderLive(ws.membership.tenant_id, id).then((res) => {
      if (!alive) return;
      if (res.status === "ok") {
        setLoadError(false);
        setOfflineCopy(res.fromCache);
        setData(res.data);
      } else if (res.status === "gone") {
        setData(null);
      } else {
        setLoadError(true);
      }
    });
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
      {offlineCopy && (
        // Say it plainly: this is what the board looked like the last time this
        // machine could reach the server, and การกดคิวยังต้องใช้เน็ต. A stale board
        // that looks live is worse than one that admits it.
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          ออฟไลน์ — นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด อาจไม่ตรงกับหน้างานตอนนี้ และยังกดคุมคิวไม่ได้จนกว่าเน็ตจะกลับมา
        </p>
      )}
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
