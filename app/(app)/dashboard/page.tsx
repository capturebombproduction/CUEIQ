import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Music2 } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { JoinDemo } from "@/components/join-demo";
import { EventsList } from "@/components/event/events-list";
import { CreateFromTemplateButton } from "@/components/event/create-from-template-button";
import { canCreateAnyEvent, canEditGroup } from "@/lib/permissions";
import { type EventRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }
  // label_staff is overview-only — send them to their primary surface.
  if (ws.perms.tenantRole === "label_staff") redirect("/overview");

  const supabase = createClient();
  const tid = ws.membership.tenant_id;
  const [{ data }, { data: tplRow }] = await Promise.all([
    supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", tid)
      .eq("is_template", false) // templates live outside the normal event list
      .eq("is_practice", false) // practice rooms live in /practice, not here
      .order("event_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("events")
      .select("id, group_id")
      .eq("tenant_id", tid)
      .eq("is_template", true)
      .limit(1)
      .maybeSingle(),
  ]);

  const events = (data ?? []) as (EventRow & {
    groups: {
      name: string;
      color: string | null;
      exempt_from_deadline: boolean;
    } | null;
  })[];
  // admin can create + duplicate anywhere; an Ar only for the band(s) they manage.
  const canCreate = canCreateAnyEvent(ws.perms);
  const editableGroups = ws.groups
    .filter((g) => canEditGroup(ws.perms, g.id))
    .map((g) => ({ id: g.id, name: g.name }));
  const editableGroupIds = editableGroups.map((g) => g.id);
  // "create from template" is offered to ANY event-creator (admin, or an Ar of
  // any band) once a template exists — RLS now lets every creator READ the
  // template skeleton (migration 0029). Cloning into a different band keeps only
  // the structure (no songs/mic/audio); that's handled in the clone itself.
  const template = tplRow as { id: string; group_id: string } | null;
  const showTemplate = !!template && canCreate && editableGroups.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">All Events</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name} · {events.length}{" "}
            {events.length === 1 ? "Event" : "Events"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showTemplate && template && (
            <CreateFromTemplateButton
              templateId={template.id}
              templateGroupId={template.group_id}
              groups={editableGroups}
            />
          )}
          {canCreate && (
            <Button asChild>
              <Link href="/events/new">
                <Plus className="h-4 w-4" /> New Event
              </Link>
            </Button>
          )}
        </div>
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Music2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No events yet</p>
            {canCreate && (
              <Button asChild variant="outline">
                <Link href="/events/new">
                  <Plus className="h-4 w-4" /> Create your first event
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <EventsList events={events} editableGroupIds={editableGroupIds} />
      )}
    </div>
  );
}
