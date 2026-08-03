// Desktop festival Running Order builder — mirrors
// app/(app)/events/[id]/run-order/page.tsx. Replicates the server's data assembly
// client-side, then reuses RunOrderBuilder verbatim. Approvers only (RLS enforces
// the writes too). Edits sync to the web via the shared Supabase.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ListOrdered, Radio } from "lucide-react";
import { canApprove } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshButton } from "@/components/refresh-button";
import { RunOrderBuilder } from "@/components/event/run-order-builder";
import { useWorkspace } from "~/data/workspace-context";
import { loadRunOrderBuild, type RunOrderBuild } from "~/data/run-order";

export function RunOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { loading, ws } = useWorkspace();
  const [data, setData] = useState<RunOrderBuild | null | undefined>(undefined);
  // A failed read used to be indistinguishable from a deleted event, and both
  // bounced to /overview — so at a venue the builder just vanished with no reason.
  const [loadError, setLoadError] = useState(false);
  const [offlineCopy, setOfflineCopy] = useState(false);

  useEffect(() => {
    if (!ws?.membership || !id) return;
    let alive = true;
    const groupName = new Map(ws.groups.map((g) => [g.id, g.name]));
    loadRunOrderBuild(ws.membership.tenant_id, id, groupName).then((res) => {
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
  if (!ws?.membership || !canApprove(ws.perms)) return <Navigate to="/dashboard" replace />;
  if (data === undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
          <p>โหลดลำดับงานไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
          <RefreshButton label="ลองใหม่" />
        </CardContent>
      </Card>
    );
  }
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
      {offlineCopy && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          ออฟไลน์ — นี่คือลำดับงานที่เครื่องนี้เก็บไว้ล่าสุด ดูได้แต่ยังแก้ไม่ได้จนกว่าเน็ตจะกลับมา
        </p>
      )}
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
