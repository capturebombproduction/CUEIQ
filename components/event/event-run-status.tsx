"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Radio, Clock, CheckCircle2, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatClockOfDay,
  formatCountdown,
  parseClockToSeconds,
} from "@/lib/time";
import type { RunSeqLive } from "@/components/event/event-live-caller";

// seconds-since-midnight (local) for a Date — to compare a live timestamp with the
// planned clock-of-day. Mirrors event-live-caller.
const secOfDay = (d: Date) =>
  d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

// Fold a clock-of-day difference back into ±12h so an evening show reads "+2m",
// never a ~1440-minute wrap. Mirrors event-live-caller.
function normMin(m: number): number {
  let n = m;
  while (n > 720) n -= 1440;
  while (n < -720) n += 1440;
  return n;
}

// Same ±12h fold for a clock-of-day difference in SECONDS — a pending 00:30 slot
// viewed at 23:50 must read "in 40m", never −23h. Mirrors event-live-caller.
function normSec(s: number): number {
  let n = s;
  while (n > 43200) n -= 86400;
  while (n < -43200) n += 86400;
  return n;
}

/** A drift (minutes, late + / early −) as a short Thai phrase. */
function driftPhrase(min: number): string {
  if (min === 0) return "ตรงเวลา";
  return min > 0 ? `ช้า +${min} น.` : `เร็ว ${-min} น.`;
}

/**
 * Read-only, band-facing companion to the festival-wide live show-caller
 * (EventLiveCaller). It shows ONE band — on its own event page — where the whole
 * show is right now (overall drift + what's playing) and, more importantly, the
 * status of THIS band's own slot (the run_sequence row linked to this event):
 * playing now / up next in X / on deck / already done. Staff drive the show from
 * Overview → the live board; bands just watch here.
 *
 * Same data + realtime channel as EventLiveCaller, so it moves in lock-step. No
 * controls and no writes — purely a projection of run_sequence.
 */
export function EventRunStatusCard({
  rows: initial,
  selfEventId,
  tenantId,
  eventName,
  eventDate,
}: {
  rows: RunSeqLive[];
  /** This page's event id — the band's own row is the one linked to it. */
  selfEventId: string;
  tenantId: string;
  eventName: string;
  eventDate: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<RunSeqLive[]>(initial);
  const [now, setNow] = useState(() => Date.now());
  // Time/elapsed/countdowns depend on "now" + the local timezone, which differ
  // from the server's (Vercel is UTC) — gate them behind mount to avoid an SSR
  // hydration mismatch. Same pattern as event-live-caller.
  const [mounted, setMounted] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- realtime: refetch when staff change the order on the live board --------
  async function refetch() {
    let q = supabase
      .from("run_sequence")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("event_name", eventName)
      .order("sort_order", { ascending: true });
    q = eventDate ? q.eq("event_date", eventDate) : q.is("event_date", null);
    const { data } = await q;
    if (data) setRows(data as RunSeqLive[]);
  }
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    const ch = supabase.channel(
      `runorder:${tenantId}:${eventDate ?? "x"}:${encodeURIComponent(eventName)}`,
      { config: { broadcast: { self: false } } }
    );
    ch.on("broadcast", { event: "changed" }, () => refetchRef.current());
    ch.subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [supabase, tenantId, eventName, eventDate]);

  // --- derived ---------------------------------------------------------------
  const ordered = useMemo(
    () => [...rows].sort((a, b) => a.sort_order - b.sort_order),
    [rows]
  );
  const liveRow = ordered.find((r) => r.status === "live") ?? null;
  const doneRows = ordered.filter((r) => r.status === "done");
  const lastDone = doneRows.length ? doneRows[doneRows.length - 1] : null;
  const drift = liveRow?.offset_min ?? lastDone?.offset_min ?? 0;
  const started = ordered.some((r) => r.status !== "pending");
  const allDone = started && !liveRow;

  // This band's own slot in the festival order (the row linked to this event).
  const selfRow = ordered.find((r) => r.linked_event_id === selfEventId) ?? null;

  // Project a pending row's start onto the clock given the current drift.
  function projectedStartSec(r: RunSeqLive): number | null {
    const p = parseClockToSeconds(r.planned_start);
    return p == null ? null : p + drift * 60;
  }
  // A row's own start late(+)/early(−) log vs its plan. TZ-dependent → gate by mounted.
  function startLateMin(r: RunSeqLive): number | null {
    const p = parseClockToSeconds(r.planned_start);
    if (p == null || !r.actual_start) return null;
    return normMin(Math.round((secOfDay(new Date(r.actual_start)) - p) / 60));
  }

  const nowDate = new Date(now);
  const driftTone = drift === 0 ? "ok" : drift > 0 ? "late" : "early";

  // self-slot summary line
  function SelfStatus() {
    if (!selfRow) {
      return (
        <p className="text-sm text-muted-foreground">
          วงนี้ยังไม่ถูกผูกกับลำดับในคิวงาน — ดูภาพรวมได้ที่บอร์ดเต็ม
        </p>
      );
    }
    if (selfRow.status === "live") {
      const elapsed = selfRow.actual_start
        ? Math.max(0, (now - Date.parse(selfRow.actual_start)) / 1000)
        : 0;
      return (
        <div className="flex items-baseline gap-2">
          <Badge className="gap-1 bg-primary text-primary-foreground">
            <Radio className="h-3 w-3" /> คิวคุณ — กำลังเล่น
          </Badge>
          {mounted && (
            <span className="font-mono text-lg font-bold tabular-nums">
              {Math.floor(elapsed / 60)}:
              {String(Math.floor(elapsed % 60)).padStart(2, "0")}
            </span>
          )}
        </div>
      );
    }
    if (selfRow.status === "done") {
      const log = mounted ? startLateMin(selfRow) : null;
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-sm font-medium",
            log == null
              ? "text-muted-foreground"
              : log > 0
                ? "text-destructive"
                : log < 0
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-success"
          )}
        >
          <CheckCircle2 className="h-4 w-4" />
          คิวคุณเล่นจบแล้ว{log != null ? ` · ${driftPhrase(log)}` : ""}
        </span>
      );
    }
    // pending — when's our turn?
    const proj = projectedStartSec(selfRow);
    const countdown = proj != null ? normSec(proj - secOfDay(nowDate)) : null;
    return (
      <div className="space-y-0.5">
        <p className="text-sm">
          <span className="font-semibold text-foreground">คิวคุณ — รอเล่น</span>
          {proj != null && (
            <>
              {" · คาดเริ่ม "}
              <b className="tabular-nums">{formatClockOfDay(proj)}</b>
            </>
          )}
        </p>
        {/* The countdown compares clock-of-day only, so it's meaningful once the
            show is actually running — before that (a band peeking days ahead) it
            would falsely read "ถึงคิวแล้ว" after 15:45 on any day. Show it only when
            the show has started; otherwise the planned start above is enough. */}
        {mounted && started && countdown != null && (
          <p
            className={cn(
              "text-sm font-medium tabular-nums",
              countdown <= 0 ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {countdown > 0 ? (
              <>อีก {formatCountdown(Math.round(countdown))}</>
            ) : (
              <>ถึงคิวแล้ว — เตรียมขึ้นได้เลย</>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border-l-4 bg-card p-4",
        liveRow ? "border-l-primary" : "border-l-transparent"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
          <Clock className="h-4 w-4" /> สถานะคิวงาน (Live)
        </p>
        <Badge
          className={cn(
            "h-7 px-2.5 text-xs",
            driftTone === "ok" && "bg-success/15 text-success",
            driftTone === "late" && "bg-destructive/15 text-destructive",
            driftTone === "early" && "bg-sky-500/15 text-sky-600 dark:text-sky-400"
          )}
          variant="secondary"
        >
          {started ? driftPhrase(drift) : "ยังไม่เริ่มงาน"}
        </Badge>
      </div>

      {/* This band's own slot — the headline for a band watching its own page */}
      <div className="mt-3">
        <SelfStatus />
      </div>

      {/* Overall: what's playing festival-wide right now */}
      <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">
        {allDone ? (
          "จบงานแล้ว 🎉"
        ) : liveRow ? (
          <>
            ตอนนี้ทั้งงาน:{" "}
            <span className="font-medium text-foreground">
              {liveRow.title || "(ไม่มีชื่อ)"}
            </span>
          </>
        ) : (
          "ยังไม่เริ่มงาน"
        )}
      </p>

      <Button variant="outline" size="sm" asChild className="mt-3">
        <Link href={`/events/${selfEventId}/run-order/live`}>
          <ExternalLink className="h-4 w-4" /> ดูบอร์ดเต็ม
        </Link>
      </Button>
    </div>
  );
}
