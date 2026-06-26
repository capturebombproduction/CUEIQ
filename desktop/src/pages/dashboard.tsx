// Desktop dashboard — the events list. Mirrors app/(app)/dashboard/page.tsx but
// fetches client-side, then renders the SAME EventsList component the web uses
// (search + next-show banner + offline-ready badges all reused verbatim).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Music2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EventsList } from "@/components/event/events-list";
import { canCreateAnyEvent, canEditGroup, viewableGroups } from "@/lib/permissions";
import { useWorkspace } from "~/data/workspace-context";
import { loadEventsList, type EventWithGroup } from "~/data/events-list";

export function Dashboard() {
  const { ws } = useWorkspace();
  const [events, setEvents] = useState<EventWithGroup[] | null>(null);

  // Per-band scope: label-wide → all bands; a band-tier user → only their own.
  const viewableGroupIds = ws
    ? viewableGroups(ws.perms, ws.groups).map((g) => g.id)
    : [];
  const editableGroupIds = ws
    ? ws.groups.filter((g) => canEditGroup(ws.perms, g.id)).map((g) => g.id)
    : [];
  const scopeKey = viewableGroupIds.join(",");

  useEffect(() => {
    if (!ws?.membership) return;
    let alive = true;
    loadEventsList(ws.membership.tenant_id, viewableGroupIds).then((data) => {
      if (alive) setEvents(data);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, scopeKey]);

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label — เข้าใช้งานผ่านเว็บเพื่อรับสิทธิ์ก่อน
        </CardContent>
      </Card>
    );
  }

  const canCreate = canCreateAnyEvent(ws.perms);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">All Events</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name}
            {events ? ` · ${events.length} ${events.length === 1 ? "Event" : "Events"}` : ""}
          </p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link to="/events/new">
              <Plus className="h-4 w-4" /> New Event
            </Link>
          </Button>
        )}
      </div>

      {events === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดงาน…</p>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Music2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No events yet</p>
            {canCreate && (
              <Button asChild variant="outline">
                <Link to="/events/new">
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
