import Link from "next/link";
import { Plus, Music2 } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { JoinDemo } from "@/components/join-demo";
import { EventsList } from "@/components/event/events-list";
import { canEdit, type EventRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  const supabase = createClient();
  const { data } = await supabase
    .from("events")
    .select("*, groups(name, color, exempt_from_deadline)")
    .eq("tenant_id", ws.membership.tenant_id)
    .order("event_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const events = (data ?? []) as (EventRow & {
    groups: {
      name: string;
      color: string | null;
      exempt_from_deadline: boolean;
    } | null;
  })[];
  const editable = canEdit(ws.membership.role);

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
        {editable && (
          <Button asChild>
            <Link href="/events/new">
              <Plus className="h-4 w-4" /> New Event
            </Link>
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Music2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No events yet</p>
            {editable && (
              <Button asChild variant="outline">
                <Link href="/events/new">
                  <Plus className="h-4 w-4" /> Create your first event
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <EventsList events={events} editable={editable} />
      )}
    </div>
  );
}
