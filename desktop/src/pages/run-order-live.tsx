// Desktop festival LIVE show-caller — mirrors
// app/(app)/events/[id]/run-order/live/page.tsx. Any tenant member may WATCH; only
// approvers DRIVE (canControl + RLS). Reuses EventLiveCaller verbatim; realtime sync
// runs over the same Supabase channel the web uses, so web + desktop stay in step.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ChevronLeft, WifiOff } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshButton } from "@/components/refresh-button";
import { canApprove } from "@/lib/permissions";
import { EventLiveCaller } from "@/components/event/event-live-caller";
import { useWorkspace } from "~/data/workspace-context";
import { loadRunOrderLive, type RunOrderLive } from "~/data/run-order";
import { ImmersiveLoading } from "~/components/immersive-loading";

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
    // Immersive route: no header to leave by while the reads run out their budgets.
    return <ImmersiveLoading eventId={id} label="กำลังโหลด…" />;
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
          {/* The shell hides its header on this route and the desktop has no browser
              back button: without this the failed card is a dead end. */}
          <Link
            to={`/events/${id}`}
            className="inline-flex h-11 items-center gap-1 rounded-[3px] px-2 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            กลับ
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (!data) return <Navigate to="/overview" replace />;
  const canControl = canApprove(ws.perms);

  // The route is immersive (shell.tsx hides the header), so the caller's own top bar
  // carries the title, the show name and the way back — anything rendered around it
  // here would sit outside that bar.
  return (
    <EventLiveCaller
      tenantId={ws.membership.tenant_id}
      eventName={data.name}
      eventDate={data.date}
      eventId={id!}
      initial={data.seqs}
      canControl={canControl}
      backHref={canControl ? `/events/${id}/run-order` : `/events/${id}`}
      backLabel={canControl ? "Running Order" : data.name}
      notice={
        offlineCopy ? (
          // Say it plainly: this is what the board looked like the last time this
          // machine could reach the server, and การกดคิวยังต้องใช้เน็ต. A stale board
          // that looks live is worse than one that admits it.
          <p className="flex items-start gap-2 rounded-[2px] bg-warning/[.12] px-3 py-2 text-[13px] text-foreground shadow-[inset_3px_0_0_hsl(var(--warning))]">
            <WifiOff className="mt-0.5 h-4 w-4 flex-none text-warning-ink" aria-hidden />
            <span>
              ออฟไลน์ — นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด อาจไม่ตรงกับที่เครื่องอื่นเห็น
              คุมคิวต่อได้ตามปกติ ทุกอย่างที่กดจะถูกเก็บไว้และซิงค์ให้เมื่อเน็ตกลับมา
            </span>
          </p>
        ) : null
      }
    />
  );
}
