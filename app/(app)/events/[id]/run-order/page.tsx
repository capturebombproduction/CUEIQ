import { redirect } from "next/navigation";
import Link from "next/link";
import { ListOrdered, Radio } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import {
  RunOrderBuilder,
  type RunSequence,
  type RunBandEvent,
} from "@/components/event/run-order-builder";

export const dynamic = "force-dynamic";

// Festival-wide running order. The [id] is any one event of the show; the festival is
// every event sharing its name + date (the same grouping the Overview uses). Only
// approvers (admin + label_staff) build it — RLS enforces it too.
export default async function RunOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  if (!canApprove(ws.perms)) redirect("/dashboard");
  const fromOverview = from === "overview";
  const tid = ws.membership.tenant_id;
  const supabase = await createClient();

  const { data: ev } = await supabase
    .from("events")
    .select("id, name, event_date")
    .eq("id", id)
    .single();
  if (!ev) redirect("/overview");

  // Every band event of this festival (same name + date).
  let fq = supabase
    .from("events")
    .select("id, group_id")
    .eq("tenant_id", tid)
    .eq("name", ev.name)
    .eq("is_template", false)
    .eq("is_practice", false);
  fq = ev.event_date ? fq.eq("event_date", ev.event_date) : fq.is("event_date", null);
  const { data: festEvents } = await fq;

  const ids = (festEvents ?? []).map((e) => e.id);
  const { data: stages } = ids.length
    ? await supabase
        .from("schedule_items")
        .select("event_id, start_time, end_time")
        .eq("tenant_id", tid)
        .eq("kind", "stage")
        .in("event_id", ids)
    : { data: [] as { event_id: string; start_time: string | null; end_time: string | null }[] };

  const groupName = new Map(ws.groups.map((g) => [g.id, g.name]));
  const stageBy = new Map((stages ?? []).map((s) => [s.event_id, s]));
  const bandEvents: RunBandEvent[] = (festEvents ?? []).map((e) => ({
    id: e.id,
    group_name: groupName.get(e.group_id) ?? "—",
    stage_start: stageBy.get(e.id)?.start_time ?? null,
    stage_end: stageBy.get(e.id)?.end_time ?? null,
  }));

  let rq = supabase
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", tid)
    .eq("event_name", ev.name)
    .order("sort_order", { ascending: true });
  rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
  const { data: seqs } = await rq;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={fromOverview ? "/overview" : `/events/${ev.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {fromOverview ? "Overview" : ev.name}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ListOrdered className="h-6 w-6" /> Running Order
          </h1>
          <Button asChild>
            <Link
              href={`/events/${ev.id}/run-order/live${
                fromOverview ? "?from=overview" : ""
              }`}
            >
              <Radio className="h-4 w-4" /> คุมคิว (Live)
            </Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {ev.name}
          {ev.event_date ? ` · ${ev.event_date}` : ""} — ลำดับงานทั้งงาน (สำหรับสตาฟคุมคิว)
        </p>
      </div>
      <RunOrderBuilder
        tenantId={tid}
        eventName={ev.name}
        eventDate={ev.event_date}
        initial={(seqs ?? []) as RunSequence[]}
        bandEvents={bandEvents}
      />
    </div>
  );
}
