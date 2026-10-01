// Desktop "edit event metadata" — mirrors app/(app)/events/[id]/edit/page.tsx.
// Reuses the web EventForm (mode="edit"); edits sync to the web app via the shared
// Supabase. Loads the event bundle client-side like the desktop event detail page.
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { canApprove, canEditGroup, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/page-title";
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
    // data-stage-centred: one centred column (components/stage-light.tsx)
    <div data-stage-centred className="mx-auto max-w-2xl space-y-3">
      <Button asChild variant="ghost" className="no-print -ml-3 text-primary-ink">
        <Link to={`/events/${id}`}>
          <ArrowLeft aria-hidden /> กลับไปหน้างาน
        </Link>
      </Button>
      <PageTitle title="Edit Event" />
      <p className="truncate text-[13px] text-muted-foreground">แก้ไขข้อมูลงาน — {bundle.event.name}</p>
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
