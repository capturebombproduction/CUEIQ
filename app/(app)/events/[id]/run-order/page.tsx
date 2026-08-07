import { redirect } from "next/navigation";
import Link from "next/link";
import { ListOrdered, Radio } from "lucide-react";
import { getEventRow, getWorkspace } from "@/lib/queries";
import { canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { assertReadsSucceeded } from "@/lib/read-guard";
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

  // Same read, same guard as the live caller next door (see that file for the
  // incident). A `.single()` whose `.error` is discarded cannot tell "this show was
  // deleted" from "this one read timed out", and here the blind answer was to bounce
  // the staff member building the running order back to /overview with no
  // explanation at all. getEventRow keeps the redirect for a genuinely missing /
  // RLS-hidden / malformed-id event and throws on a failed read.
  const ev = await getEventRow(id);
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
  const festRes = await fq;
  // A FAILED READ IS NOT A ZERO COUNT (lib/read-guard.ts). Discarding `.error` here
  // told the staff member building the running order that this festival has no
  // bands in it: an empty "นำเข้าจากเวทีวง" and an empty link dropdown, with no
  // hint that a read had failed. Throw instead — app/(app)/error.tsx offers a retry.
  assertReadsSucceeded("RunOrderPage", { "งานในเทศกาล": festRes });
  const festEvents = festRes.data ?? [];

  const ids = festEvents.map((e) => e.id);
  // Ordered by start_time so a band's slots arrive in the order it actually plays —
  // the builder seeds the running order straight off this list.
  const stagesRes: {
    data: { event_id: string; start_time: string | null; end_time: string | null }[] | null;
    error: { message?: string | null } | null;
  } = ids.length
    ? await supabase
        .from("schedule_items")
        .select("event_id, start_time, end_time")
        .eq("tenant_id", tid)
        .eq("kind", "stage")
        .in("event_id", ids)
        .order("start_time", { ascending: true })
    : { data: [], error: null };
  // A stage read that failed reaches the builder as "this band has no slot", and
  // the seeded running order then announces the wrong act — or drops it entirely.
  assertReadsSucceeded("RunOrderPage", { "เวลาขึ้นเวที": stagesRes });
  const stages = stagesRes.data ?? [];

  const groupName = new Map(ws.groups.map((g) => [g.id, g.name]));
  // A band can hold SEVERAL stage slots on one festival day — mig 0036 caps only
  // 'photo' at one row per event. A Map keyed by event_id kept whichever row the query
  // returned last, so a band booked twice reached the running order once (often at the
  // wrong time) and the live caller never announced the other slot. Key a LIST instead.
  const stagesBy = new Map<string, { start_time: string | null; end_time: string | null }[]>();
  for (const s of stages) {
    const list = stagesBy.get(s.event_id);
    if (list) list.push(s);
    else stagesBy.set(s.event_id, [s]);
  }
  // One entry PER STAGE SLOT, all carrying the band's event id (= linked_event_id).
  // An event with no stage row still gets one slot-less entry so the builder's link
  // dropdown can still reach it.
  const bandEvents: RunBandEvent[] = festEvents.flatMap((e) => {
    const base = { id: e.id, group_name: groupName.get(e.group_id) ?? "—" };
    const slots = stagesBy.get(e.id);
    return slots?.length
      ? slots.map((s) => ({ ...base, stage_start: s.start_time, stage_end: s.end_time }))
      : [{ ...base, stage_start: null, stage_end: null }];
  });

  let rq = supabase
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", tid)
    .eq("event_name", ev.name)
    .order("sort_order", { ascending: true });
  rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
  const seqRes = await rq;
  // THE SHARPEST ONE. RunOrderBuilder already refuses to wipe its rows on an
  // untrusted empty read (see its runRollback: an empty answer is not proof the
  // order is gone, because the next "นำเข้าจากเวทีวง" reads linked_event_id off
  // these very rows and would insert every act a SECOND time and broadcast the
  // duplicate to the live board) — and the read that SEEDS that component had no
  // guard at all. `seqs ?? []` handed it the same empty list the component was
  // written never to believe.
  assertReadsSucceeded("RunOrderPage", { "ลำดับคิวงาน": seqRes });
  const seqs = seqRes.data ?? [];

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
        initial={seqs as RunSequence[]}
        bandEvents={bandEvents}
      />
    </div>
  );
}
