import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Radio } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import {
  EventLiveCaller,
  type RunSeqLive,
} from "@/components/event/event-live-caller";

export const dynamic = "force-dynamic";

// The festival-wide LIVE show-caller (Event Live Mode — Phase 2). The [id] is any one
// event of the show; the running order spans every event sharing its name + date.
// Any tenant member may WATCH; only approvers (admin + label_staff) drive it — RLS
// enforces the writes too.
export default async function RunOrderLivePage({
  params,
}: {
  params: { id: string };
}) {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  const tid = ws.membership.tenant_id;
  const supabase = createClient();

  const { data: ev } = await supabase
    .from("events")
    .select("id, name, event_date")
    .eq("id", params.id)
    .single();
  if (!ev) notFound();

  let rq = supabase
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", tid)
    .eq("event_name", ev.name)
    .order("sort_order", { ascending: true });
  rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
  const { data: seqs } = await rq;

  const canControl = canApprove(ws.perms);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Approvers go back to the builder; watchers (members) can't open it
            (it redirects), so send them back to the event instead. */}
        <Link
          href={canControl ? `/events/${ev.id}/run-order` : `/events/${ev.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> {canControl ? "Running Order" : ev.name}
        </Link>
      </div>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Radio className="h-6 w-6 text-primary" /> คุมคิวงาน (Live)
        </h1>
        <p className="text-sm text-muted-foreground">
          {ev.name}
          {ev.event_date ? ` · ${ev.event_date}` : ""} — สำหรับสตาฟคุมคิวสด ทั้งงาน
        </p>
      </div>
      <EventLiveCaller
        tenantId={tid}
        eventName={ev.name}
        eventDate={ev.event_date}
        initial={(seqs ?? []) as RunSeqLive[]}
        canControl={canControl}
      />
    </div>
  );
}
