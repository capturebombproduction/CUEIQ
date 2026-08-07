import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Radio } from "lucide-react";
import { getEventRow, getWorkspace } from "@/lib/queries";
import { canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { assertReadsSucceeded } from "@/lib/read-guard";
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  const tid = ws.membership.tenant_id;
  const fromOverview = from === "overview";
  const supabase = await createClient();

  // getEventRow, not a bare `.single()` with the `.error` thrown away. This is the
  // highest-stakes single-row event read in the product: when staff press เริ่ม,
  // /api/notify fans "🔴 งานเริ่มแล้ว (Live)" out with a per-recipient link to THIS
  // route (lib/dead-link.ts runOrderLiveLink), so ~19 phones open this page within
  // seconds of each other. `.single()` resolves "there is no such row" and
  // "statement timeout / 429 / dead pooler" identically as { data: null, error },
  // so discarding `.error` meant the one phone that drew the hiccup was shown
  // app/(app)/not-found.tsx — "ไม่พบงานนี้ — งานนี้อาจถูกลบไปแล้ว หรือบัญชีของคุณไม่มีสิทธิ์
  // เข้าถึง" — for a festival that was running in front of them. getEventRow still
  // returns null (→ this notFound) for a genuinely missing, RLS-hidden or
  // malformed-id event, and THROWS when the read itself failed, which the (app)
  // error boundary renders as a retryable error instead of a false obituary.
  const ev = await getEventRow(id);
  if (!ev) notFound();

  let rq = supabase
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", tid)
    .eq("event_name", ev.name)
    .order("sort_order", { ascending: true });
  rq = ev.event_date ? rq.eq("event_date", ev.event_date) : rq.is("event_date", null);
  const seqRes = await rq;
  // The event read above refuses to call a failed read a missing show; this one
  // must refuse to call a failed read an empty running order. A FAILED READ IS NOT
  // A ZERO COUNT (lib/read-guard.ts). ~19 phones open this route within seconds of
  // each other when staff press เริ่ม, so the one that draws a pooler hiccup was
  // being shown "ยังไม่มีลำดับงาน" for a festival that is running in front of it —
  // and an approver on that phone drives the show from a blank board. A retryable
  // error card is the honest answer; the order is still there.
  assertReadsSucceeded("RunOrderLivePage", { "ลำดับคิวงาน": seqRes });
  const seqs = seqRes.data ?? [];

  const canControl = canApprove(ws.perms);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Launched from Overview → back to Overview (the Master flow). Otherwise
            approvers go back to the builder; watchers (members) can't open it (it
            redirects), so send them back to the event instead. */}
        <Link
          href={
            fromOverview
              ? "/overview"
              : canControl
                ? `/events/${ev.id}/run-order`
                : `/events/${ev.id}`
          }
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />{" "}
          {fromOverview ? "Overview" : canControl ? "Running Order" : ev.name}
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
        eventId={ev.id}
        initial={seqs as RunSeqLive[]}
        canControl={canControl}
      />
    </div>
  );
}
