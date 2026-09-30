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
import { canCreateAnyEvent, canEditGroup, canLiveEdit, viewableGroups } from "@/lib/permissions";
import { bkkTodayKey } from "@/lib/time";
import { earliestStartByEvent, practiceRoomByGroup } from "@/lib/next-show";
import { type EventRow } from "@/lib/types";
import { WhatsNew } from "@/components/whats-new";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }
  // label_staff is overview-only — send them to their primary surface.
  if (ws.perms.tenantRole === "label_staff") redirect("/overview");

  const supabase = await createClient();
  const tid = ws.membership.tenant_id;
  // Per-band scope: label-wide (admin/ceo) → all bands; a band-tier user → only
  // their own. Drives the event list AND, downstream, which bands' audio the
  // client pre-caches (EventsList derives libraryGroupIds from these events) —
  // so a one-band member no longer downloads every band's library.
  const viewableGroupIds = viewableGroups(ws.perms, ws.groups).map((g) => g.id);
  // The "งานถัดไป" banner (lib/next-show.ts): every upcoming show's call time, and —
  // for anyone who cannot drive Live Mode — the practice room its "ซ้อม" opens.
  // Best-effort: a failed read here only drops those two extras, never the list.
  const canRunLive = canLiveEdit(ws.perms);
  const [{ data }, { data: tplRows }, { data: callRows }, { data: roomRows }, { data: runRows }] = await Promise.all([
    supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", tid)
      .in("group_id", viewableGroupIds) // only bands this user may view
      .eq("is_template", false) // templates live outside the normal event list
      .eq("is_practice", false) // practice rooms live in /practice, not here
      .order("event_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    // each band has its OWN demo-draft template ("Demo Draft Events").
    supabase
      .from("events")
      .select("id, group_id")
      .eq("tenant_id", tid)
      .eq("is_template", true),
    supabase
      .from("schedule_items")
      .select("event_id, start_time, events!inner(event_date, group_id, is_template)")
      .not("start_time", "is", null)
      .gte("events.event_date", bkkTodayKey())
      .in("events.group_id", viewableGroupIds)
      .eq("events.is_template", false),
    canRunLive
      ? Promise.resolve({ data: null })
      : supabase
          .from("events")
          .select("id, group_id")
          .eq("tenant_id", tid)
          .in("group_id", viewableGroupIds)
          .eq("is_practice", true)
          .order("created_at", { ascending: false }),
    canRunLive
      ? Promise.resolve({ data: null })
      : supabase
          .from("practice_runs")
          .select("event_id, group_id")
          .in("group_id", viewableGroupIds)
          .order("created_at", { ascending: false })
          .limit(50),
  ]);
  const callTimes = earliestStartByEvent(
    (callRows ?? []) as { event_id: string; start_time: string | null }[]
  );
  const roomByGroup = practiceRoomByGroup(
    (roomRows ?? []) as { id: string; group_id: string }[],
    (runRows ?? []) as { event_id: string | null; group_id: string }[]
  );

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
  // "create from template": each band clones ITS OWN demo-draft template, so a
  // clone never pulls another band's content. Offer only the user's editable
  // bands that actually have a template. (RLS lets any creator READ a template
  // skeleton — migration 0029.)
  const templates = (tplRows ?? []) as { id: string; group_id: string }[];
  const templateByGroup = new Map(templates.map((t) => [t.group_id, t.id]));
  const templateGroups = editableGroups
    .filter((g) => templateByGroup.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, templateId: templateByGroup.get(g.id)! }));
  const showTemplate = canCreate && templateGroups.length > 0;

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
          {showTemplate && (
            <CreateFromTemplateButton groups={templateGroups} />
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

      <WhatsNew canEdit={editableGroupIds.length > 0} />

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
        <EventsList
          events={events}
          editableGroupIds={editableGroupIds}
          callTimes={callTimes}
          canRunLive={canRunLive}
          practiceRoomByGroup={roomByGroup}
        />
      )}
    </div>
  );
}
