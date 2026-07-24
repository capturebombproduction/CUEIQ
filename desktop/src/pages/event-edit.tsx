// Desktop "edit event metadata" — mirrors app/(app)/events/[id]/edit/page.tsx.
// Reuses the web EventForm (mode="edit"); edits sync to the web app via the shared
// Supabase. Loads the event bundle client-side like the desktop event detail page.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { canApprove, canEditGroup, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { useWorkspace } from "~/data/workspace-context";

export function EditEventPage() {
  const { id } = useParams<{ id: string }>();
  const { loading, ws } = useWorkspace();
  const [state, setState] = useState<{ loading: boolean; bundle: EventBundle | null }>({
    loading: true,
    bundle: null,
  });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ loading: true, bundle: null });
    loadEventBundle(id)
      .then((bundle) => alive && setState({ loading: false, bundle }))
      .catch(() => alive && setState({ loading: false, bundle: null }));
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading || state.loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>;
  }
  const bundle = state.bundle;
  if (!bundle) return <Navigate to="/dashboard" replace />;
  if (!ws || !canEditGroup(ws.perms, bundle.event.group_id)) {
    return <Navigate to={`/events/${id}`} replace />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to={`/events/${id}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">แก้ไขข้อมูลงาน</h1>
      </div>
      <EventForm
        mode="edit"
        event={bundle.event}
        tenantId={bundle.event.tenant_id}
        userId={ws.user?.id}
        groups={editableGroups(ws.perms, ws.groups)}
        canApprove={canApprove(ws.perms)}
      />
    </div>
  );
}
