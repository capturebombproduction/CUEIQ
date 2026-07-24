// Desktop "create event" — mirrors app/(app)/events/new/page.tsx. Reuses the web
// EventForm verbatim (it talks to the same Supabase, so a show created here syncs
// to the web app automatically). useRouter()/createClient() resolve through the
// desktop shims, so the form Just Works.
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { canApprove, canCreateAnyEvent, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useWorkspace } from "~/data/workspace-context";

export function NewEventPage() {
  const { loading, ws } = useWorkspace();
  if (loading || !ws) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>;
  }
  if (!ws.membership || !ws.tenant || !ws.user || !canCreateAnyEvent(ws.perms)) {
    return <Navigate to="/dashboard" replace />;
  }
  const groups = editableGroups(ws.perms, ws.groups);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" /> กลับ
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">สร้างงานใหม่</h1>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีวงที่คุณดูแล — ติดต่อแอดมินเพื่อขอสิทธิ์จัดการวง
          </CardContent>
        </Card>
      ) : (
        <EventForm
          mode="create"
          tenantId={ws.membership.tenant_id}
          userId={ws.user.id}
          groups={groups}
          defaultGroupId={groups[0]?.id}
          canApprove={canApprove(ws.perms)}
        />
      )}
    </div>
  );
}
