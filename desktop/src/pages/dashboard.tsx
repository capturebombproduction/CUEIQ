// Desktop dashboard — the events list. Mirrors app/(app)/dashboard/page.tsx but
// fetches client-side, then renders the SAME EventsList component the web uses
// (search + next-show banner + offline-ready badges all reused verbatim).
import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { EventsList } from "@/components/event/events-list";
import { canEditGroup, viewableGroups } from "@/lib/permissions";
import { type EventRow } from "@/lib/types";
import { useWorkspace } from "~/data/workspace-context";

type EventWithGroup = EventRow & {
  groups: { name: string; color: string | null; exempt_from_deadline: boolean } | null;
};

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
    const supabase = createClient();
    supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", ws.membership.tenant_id)
      .in("group_id", viewableGroupIds)
      .eq("is_template", false)
      .eq("is_practice", false)
      .order("event_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (alive) setEvents((data ?? []) as EventWithGroup[]);
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
      </div>

      {events === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดงาน…</p>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Music2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No events yet</p>
          </CardContent>
        </Card>
      ) : (
        <EventsList events={events} editableGroupIds={editableGroupIds} />
      )}
    </div>
  );
}
