import Link from "next/link";
import { Plus, CalendarDays, MapPin, Music2 } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { JoinDemo } from "@/components/join-demo";
import {
  canEdit,
  EVENT_TYPES,
  type EventRow,
  type EventType,
  type GroupStatus,
} from "@/lib/types";
import { shortClock } from "@/lib/time";

export const dynamic = "force-dynamic";

function formatDate(date: string | null): string {
  if (!date) return "ยังไม่ระบุวันที่";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function DashboardPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  const supabase = createClient();
  const { data } = await supabase
    .from("events")
    .select("*, groups(name)")
    .eq("tenant_id", ws.membership.tenant_id)
    .order("event_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const events = (data ?? []) as (EventRow & {
    groups: { name: string } | null;
  })[];
  const editable = canEdit(ws.membership.role);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">โชว์ทั้งหมด</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name} · {events.length} งาน
          </p>
        </div>
        {editable && (
          <Button asChild>
            <Link href="/events/new">
              <Plus className="h-4 w-4" /> สร้างงานใหม่
            </Link>
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Music2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">ยังไม่มีงาน</p>
            {editable && (
              <Button asChild variant="outline">
                <Link href="/events/new">
                  <Plus className="h-4 w-4" /> สร้างงานแรก
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((ev) => (
            <Link key={ev.id} href={`/events/${ev.id}`} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold leading-tight group-hover:text-primary">
                      {ev.name}
                    </h2>
                    <StatusBadge status={ev.status as GroupStatus} />
                  </div>
                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    <p className="flex items-center gap-2">
                      <CalendarDays className="h-4 w-4 shrink-0" />
                      {formatDate(ev.event_date)}
                      {ev.show_start_time && (
                        <span className="tabular-nums">
                          · {shortClock(ev.show_start_time)} น.
                        </span>
                      )}
                    </p>
                    {ev.venue && (
                      <p className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 shrink-0" />
                        <span className="truncate">{ev.venue}</span>
                      </p>
                    )}
                    <p className="flex items-center gap-2">
                      <Music2 className="h-4 w-4 shrink-0" />
                      {ev.groups?.name ?? "—"} ·{" "}
                      {EVENT_TYPES[ev.event_type as EventType]?.label ??
                        ev.event_type}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
