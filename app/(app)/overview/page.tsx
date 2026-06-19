import Link from "next/link";
import { LayoutGrid, AlarmClock, Users } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { JoinDemo } from "@/components/join-demo";
import { EventStatusActions } from "@/components/overview/event-status-actions";
import { cn } from "@/lib/utils";
import { shortClock, deadlineInfo } from "@/lib/time";
import {
  canEdit,
  type EventRow,
  type GroupStatus,
  type Member,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const DEADLINE_BADGE: Record<string, string> = {
  overdue: "bg-destructive text-destructive-foreground",
  urgent: "bg-orange-500 text-white",
  soon: "bg-amber-400 text-black",
  ok: "bg-muted text-muted-foreground",
};

function fmtDate(date: string | null): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

interface GroupRow {
  id: string;
  name: string;
  color: string | null;
  exempt_from_deadline: boolean;
}
type SchedRow = { event_id: string; kind: string; start_time: string | null };

export default async function OverviewPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) return <JoinDemo />;
  const tid = ws.membership.tenant_id;
  const editable = canEdit(ws.membership.role);
  const supabase = createClient();

  const [evRes, schedRes, memRes] = await Promise.all([
    supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", tid)
      .order("event_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("schedule_items")
      .select("event_id, kind, start_time")
      .eq("tenant_id", tid),
    supabase
      .from("members")
      .select("*")
      .eq("tenant_id", tid)
      .order("sort_order", { ascending: true }),
  ]);

  const events = (evRes.data ?? []) as (EventRow & { groups: GroupRow | null })[];
  const sched = (schedRes.data ?? []) as SchedRow[];
  const members = (memRes.data ?? []) as Member[];

  const timeOf = (eventId: string, kind: string) =>
    sched.find((s) => s.event_id === eventId && s.kind === kind)?.start_time ?? null;

  // bands present (from the tenant's groups), each with its events + members
  const bands = ws.groups.map((g) => ({
    group: g,
    events: events.filter((e) => e.group_id === g.id),
    members: members.filter((m) => m.group_id === g.id),
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <LayoutGrid className="h-6 w-6" /> ภาพรวมค่าย
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · {ws.groups.length} วง · {events.length} งาน
        </p>
      </div>

      {bands.length === 0 ? (
        <p className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          ยังไม่มีวง — เพิ่มที่หน้า “วง”
        </p>
      ) : (
        bands.map(({ group, events: gevents, members: gmembers }) => (
          <section key={group.id} className="space-y-3">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: group.color || "var(--primary)" }}
              />
              <h2 className="text-lg font-semibold">{group.name}</h2>
              <span className="text-sm text-muted-foreground">
                · {gevents.length} งาน · {gmembers.length} คน
              </span>
            </div>

            {gevents.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">งาน</th>
                      <th className="px-3 py-2 font-medium">วันที่</th>
                      <th className="px-3 py-2 font-medium tabular-nums">Stage</th>
                      <th className="px-3 py-2 font-medium tabular-nums">Booth</th>
                      <th className="px-3 py-2 font-medium tabular-nums">Photo</th>
                      <th className="px-3 py-2 font-medium">เดดไลน์</th>
                      <th className="px-3 py-2 font-medium">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gevents.map((ev) => {
                      const dl = group.exempt_from_deadline
                        ? null
                        : deadlineInfo(ev.deadline);
                      return (
                        <tr key={ev.id} className="border-b last:border-0 align-middle">
                          <td className="px-3 py-2">
                            <Link
                              href={`/events/${ev.id}`}
                              className="font-medium hover:text-primary hover:underline"
                            >
                              {ev.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {fmtDate(ev.event_date)}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {shortClock(timeOf(ev.id, "stage")) || "—"}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {shortClock(timeOf(ev.id, "booth")) || "—"}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {shortClock(timeOf(ev.id, "photo")) || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {dl ? (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
                                  DEADLINE_BADGE[dl.tone]
                                )}
                              >
                                <AlarmClock className="h-3 w-3" /> {dl.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {editable ? (
                              <EventStatusActions
                                eventId={ev.id}
                                initialStatus={ev.status as GroupStatus}
                              />
                            ) : (
                              <span className="text-xs">{ev.status}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {gmembers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Users className="h-4 w-4 text-muted-foreground" />
                {gmembers.map((m) => (
                  <span
                    key={m.id}
                    className="rounded-full border px-2 py-0.5 text-xs"
                  >
                    {m.mic_number != null && (
                      <span className="mr-1 font-semibold tabular-nums">
                        {m.mic_number}
                      </span>
                    )}
                    {m.nickname || m.name}
                  </span>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
