"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Play,
  SkipForward,
  Plus,
  Minus,
  Flag,
  RotateCcw,
  Timer,
  Radio,
  CheckCircle2,
  Hand,
  ListMusic,
  ImageDown,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { captureElementToImage } from "@/lib/export-image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  formatClockOfDay,
  formatCountdown,
  parseClockToSeconds,
} from "@/lib/time";

// One running-order line, with the Phase-2 live columns. Mirrors the run_sequence
// row the builder writes (components/event/run-order-builder.tsx).
export type RunSeqLive = {
  id: string;
  sort_order: number;
  title: string;
  kind: string;
  planned_start: string | null; // "HH:MM[:SS]"
  planned_end: string | null;
  buffer_seconds: number;
  linked_event_id: string | null;
  actual_start: string | null; // ISO timestamptz
  actual_end: string | null;
  status: string; // pending | live | done
  offset_min: number | null; // drift carried by this row: late + / early −
};

// Colour + label per kind — drives the left rail + chip so a staffer can read the
// board at a glance. Same kinds the builder offers.
const KIND_META: Record<string, { label: string; rail: string; chip: string }> = {
  band: { label: "วง", rail: "border-l-primary", chip: "bg-primary/15 text-primary" },
  game: { label: "เกม", rail: "border-l-emerald-500", chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  ceremony: { label: "พิธี", rail: "border-l-violet-500", chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  mc: { label: "MC", rail: "border-l-sky-500", chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  break: { label: "Break", rail: "border-l-amber-500", chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  other: { label: "อื่นๆ", rail: "border-l-muted-foreground/40", chip: "bg-muted text-muted-foreground" },
};
const kindMeta = (k: string) => KIND_META[k] ?? KIND_META.other;

// seconds-since-midnight (local) for a Date — to compare a live timestamp with the
// planned clock-of-day.
const secOfDay = (d: Date) =>
  d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

// Subtracting two clocks-of-day can wrap around midnight; fold the result back into
// ±12h so an evening show that started at 19:02 vs a 19:00 plan reads "+2m", never
// a ~1440-minute jump.
function normMin(m: number): number {
  let n = m;
  while (n > 720) n -= 1440;
  while (n < -720) n += 1440;
  return n;
}

// Same ±12h fold for a clock-of-day difference in SECONDS — a pending 00:30 slot
// viewed at 23:50 must read "in 40m", never −23h.
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

/** A play-length delta (minutes, over + / under −) vs the planned window. */
function durPhrase(min: number): string {
  if (min === 0) return "พอดีเวลา";
  return min > 0 ? `เล่นเกิน ${min} น.` : `เล่นสั้น ${-min} น.`;
}

/**
 * The festival-wide LIVE show-caller (Event Live Mode — Phase 2). Staff run the whole
 * event off this: a big clock, the current + next sequence, and the controls to
 * Start / move to Next, push downstream times (±min), and absorb slack (take buffer).
 *
 * The "drift" — how late(+)/early(−) the show is running right now — is carried on the
 * LIVE row's offset_min: it's set when a row starts (actual_start − planned_start),
 * nudged by the ± buttons / take-buffer, then frozen as that row's late/early LOG when
 * it goes done. Pending rows are projected at planned + drift. All state lives in
 * run_sequence (survives reload) and changes broadcast so every device stays in step.
 */
export function EventLiveCaller({
  tenantId,
  eventName,
  eventDate,
  eventId,
  initial,
  canControl,
}: {
  tenantId: string;
  eventName: string;
  eventDate: string | null;
  /** The event the board was opened for — anchors the "show is live" notification. */
  eventId: string;
  initial: RunSeqLive[];
  /** Approvers (admin + label_staff) run the show; everyone else watches read-only. */
  canControl: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const confirm = useConfirm();
  const [rows, setRows] = useState<RunSeqLive[]>(initial);
  const [now, setNow] = useState(() => Date.now());
  // false until the client mounts — the wall clock / elapsed / countdowns depend on
  // "now" and the local timezone, which differ from the server's (Vercel is UTC), so
  // we render stable placeholders for them during SSR/hydration to avoid a mismatch.
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const meId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random())
  );
  const channelRef = useRef<RealtimeChannel | null>(null);
  // Synchronous re-entrancy guard for the status-advancing actions (start / next).
  // `busy` disables the buttons, but only after a render — this blocks a fast
  // double-tap on a laggy tablet from firing the transition twice.
  const inFlightRef = useRef(false);

  // ticking wall clock + live elapsed (1s is plenty)
  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ordered = useMemo(
    () => [...rows].sort((a, b) => a.sort_order - b.sort_order),
    [rows]
  );
  const liveRow = ordered.find((r) => r.status === "live") ?? null;
  const doneRows = ordered.filter((r) => r.status === "done");
  const lastDone = doneRows.length ? doneRows[doneRows.length - 1] : null;
  // current drift = the live row's, else the last finished row's, else on-time.
  const drift = liveRow?.offset_min ?? lastDone?.offset_min ?? 0;
  const nextPending =
    ordered.find(
      (r) =>
        r.status === "pending" &&
        (!liveRow || r.sort_order > liveRow.sort_order)
    ) ?? null;
  const firstPending = ordered.find((r) => r.status === "pending") ?? null;
  const started = ordered.some((r) => r.status !== "pending");

  // Project a row's start onto the clock given the current drift.
  function projectedStartSec(r: RunSeqLive): number | null {
    const p = parseClockToSeconds(r.planned_start);
    return p == null ? null : p + drift * 60;
  }

  // A row's OWN late/early LOG — straight from its real start vs its plan, so it's
  // honest about that sequence regardless of how the propagating drift was later
  // nudged (±push / take-buffer change the drift carrier, not this). TZ-dependent,
  // so callers must gate it behind `mounted`.
  function startLateMin(r: RunSeqLive): number | null {
    const p = parseClockToSeconds(r.planned_start);
    if (p == null || !r.actual_start) return null;
    return normMin(Math.round((secOfDay(new Date(r.actual_start)) - p) / 60));
  }

  // How much LONGER(+)/shorter(−) a finished row actually played vs its planned
  // window (planned_end − planned_start). Uses the two absolute timestamps, so —
  // unlike startLateMin — it's timezone-independent; we still gate it behind
  // `mounted` where it's shown, beside the start-drift log. Null until both real
  // timestamps and a planned window exist.
  function durationDeltaMin(r: RunSeqLive): number | null {
    const ps = parseClockToSeconds(r.planned_start);
    const pe = parseClockToSeconds(r.planned_end);
    if (ps == null || pe == null || !r.actual_start || !r.actual_end) return null;
    let planned = pe - ps;
    if (planned < 0) planned += 86400; // window wraps past midnight
    const actual = (Date.parse(r.actual_end) - Date.parse(r.actual_start)) / 1000;
    return Math.round((actual - planned) / 60);
  }

  // --- realtime: refetch when another device changes the order ----------------
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
    ch.on("broadcast", { event: "changed" }, ({ payload }) => {
      if (payload?.sender !== meId.current) refetchRef.current();
    });
    ch.subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [supabase, tenantId, eventName, eventDate]);

  function bcast() {
    channelRef.current?.send({
      type: "broadcast",
      event: "changed",
      payload: { sender: meId.current },
    });
  }

  // Keep the screen awake while a sequence is live (backstage tablet / kiosk). The
  // browser auto-releases the lock whenever the tab is hidden (app-switch / screen
  // lock), so we ALSO re-acquire it on visibilitychange — otherwise the screen
  // sleeps mid-show and never wakes (mirrors components/event/live-mode.tsx).
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const hasLive = liveRow != null;
  useEffect(() => {
    function acquire() {
      if (!hasLive || wakeLockRef.current) return;
      navigator.wakeLock
        ?.request("screen")
        .then((wl) => {
          wl.addEventListener("release", () => {
            if (wakeLockRef.current === wl) wakeLockRef.current = null;
          });
          wakeLockRef.current = wl;
        })
        .catch(() => {});
    }
    if (hasLive) acquire();
    else {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    }
    function onVisible() {
      if (document.visibilityState === "visible") acquire();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      // also release on unmount — under SPA navigation the document survives, so a
      // sentinel left behind would keep the screen forced-awake all session.
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [hasLive]);

  // --- mutations --------------------------------------------------------------
  // One caller write, with an optional optimistic-concurrency precondition: the
  // update only lands while `expect`'s columns still hold these values (null →
  // IS NULL). A precondition that no longer holds — another controller pressed the
  // same button first, or the builder deleted the row — matches 0 rows WITHOUT an
  // error, so apply() checks the returned rows to catch it.
  type CallerUpdate = {
    id: string;
    partial: Partial<RunSeqLive>;
    expect?: Partial<RunSeqLive>;
  };

  // Optimistically apply, persist each changed row, then tell other devices.
  // Resolves false when nothing landed cleanly (error OR a precondition lost the
  // race) — in that case the board is refetched back to server truth.
  async function apply(updates: CallerUpdate[]): Promise<boolean> {
    if (!canControl || updates.length === 0) return false;
    setRows((prev) =>
      prev.map((r) => {
        const u = updates.find((x) => x.id === r.id);
        return u ? { ...r, ...u.partial } : r;
      })
    );
    setBusy(true);
    const results = await Promise.all(
      updates.map((u) => {
        let q = supabase.from("run_sequence").update(u.partial).eq("id", u.id);
        for (const [k, v] of Object.entries(u.expect ?? {})) {
          q = v == null ? q.is(k, null) : q.eq(k, v);
        }
        // select the row back: 0 rows = deleted or precondition lost the race
        return q.select("id");
      })
    );
    setBusy(false);
    const err = results.find((r) => r.error)?.error;
    const stale = results.some((r) => !r.error && (r.data?.length ?? 0) === 0);
    if (err) {
      toast.error("บันทึกไม่สำเร็จ", { description: err.message });
      // pull the board back to server truth so the optimistic rows don't linger
      refetchRef.current();
    } else if (stale) {
      toast.info("ลำดับถูกเปลี่ยนจากเครื่อง/หน้าอื่นก่อน — อัปเดตบอร์ดให้ตรงแล้ว");
      refetchRef.current();
    }
    bcast();
    return !err && !stale;
  }

  // Begin the show / start the first pending row (only when nothing is live).
  async function start() {
    if (liveRow || !firstPending || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      // Only the FIRST start of the whole show pings members — resuming a later row
      // ("เริ่มลำดับถัดไป") shouldn't. Capture before the optimistic update flips it.
      const firstStart = !started;
      const t = new Date();
      const p = parseClockToSeconds(firstPending.planned_start);
      const d = p != null ? normMin(Math.round((secOfDay(t) - p) / 60)) : drift;
      const ok = await apply([
        {
          id: firstPending.id,
          partial: { status: "live", actual_start: t.toISOString(), offset_min: d },
          // another controller (or the builder) got here first → refetch, don't start
          expect: { status: "pending" },
        },
      ]);
      // Fire-and-forget AFTER the write lands so the route's anti-spoof (it re-checks
      // run_sequence has a live row) passes. Notifies the whole label the show is on.
      if (ok && firstStart) notify("run_order_live", { eventId });
    } finally {
      inFlightRef.current = false;
    }
  }

  // End the live row (logs its actual_end + its start-offset as late/early) and start
  // the next pending one at the same instant, recomputing drift from the real clock.
  function next() {
    if (!liveRow) {
      start();
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const t = new Date();
    // Both writes are compare-and-swaps on status: if two controllers press
    // "จบ + ต่อไป" near-simultaneously, the loser matches 0 rows and refetches
    // instead of double-advancing / clobbering the new row's actual_start.
    const updates: CallerUpdate[] = [
      {
        id: liveRow.id,
        partial: { status: "done", actual_end: t.toISOString() },
        expect: { status: "live" },
      },
    ];
    if (nextPending) {
      const p = parseClockToSeconds(nextPending.planned_start);
      const d =
        p != null
          ? normMin(Math.round((secOfDay(t) - p) / 60))
          : (liveRow.offset_min ?? drift);
      updates.push({
        id: nextPending.id,
        partial: { status: "live", actual_start: t.toISOString(), offset_min: d },
        expect: { status: "pending" },
      });
    }
    apply(updates).finally(() => {
      inFlightRef.current = false;
    });
  }

  // Push downstream times: nudge the live row's drift by ±minutes (a band overran,
  // or asks for more time). Pending rows re-project immediately.
  function adjust(deltaMin: number) {
    if (!liveRow) return;
    const cur = liveRow.offset_min ?? drift;
    apply([
      {
        id: liveRow.id,
        partial: { offset_min: normMin(cur + deltaMin) },
        // conditional on the value we read: two staff pressing ± within one
        // round-trip can't silently collapse into a single lost update.
        expect: { status: "live", offset_min: liveRow.offset_min },
      },
    ]);
  }

  // Absorb being late by compressing the slack still ahead (pending buffers). The
  // absorbed slack is CONSUMED — buffer_seconds is decremented on the pending rows
  // it came from — so pressing again later can only spend what actually remains.
  function takeBuffer() {
    if (!liveRow) return;
    const cur = liveRow.offset_min ?? 0;
    if (cur <= 0) {
      toast.info("ไม่ได้ช้า — ไม่ต้องดึง buffer");
      return;
    }
    const pending = ordered.filter((r) => r.status === "pending");
    const bufMin = Math.floor(
      pending.reduce((s, r) => s + (r.buffer_seconds || 0), 0) / 60
    );
    const absorb = Math.min(cur, bufMin);
    if (absorb <= 0) {
      toast.info("ไม่มี buffer เหลือให้ดึง");
      return;
    }
    const updates: CallerUpdate[] = [
      {
        id: liveRow.id,
        partial: { offset_min: cur - absorb },
        expect: { status: "live", offset_min: liveRow.offset_min },
      },
    ];
    // drain the absorbed minutes from the pending rows' buffers, front to back
    let remain = absorb * 60;
    for (const r of pending) {
      if (remain <= 0) break;
      const take = Math.min(r.buffer_seconds || 0, remain);
      if (take <= 0) continue;
      updates.push({
        id: r.id,
        partial: { buffer_seconds: r.buffer_seconds - take },
        expect: { status: "pending", buffer_seconds: r.buffer_seconds },
      });
      remain -= take;
    }
    apply(updates);
    toast.success(`ดึง buffer ${absorb} นาที — ร่นคิวให้ทันขึ้น`);
  }

  async function resetAll() {
    const ok = await confirm({
      title: "รีเซ็ตการคุมคิว?",
      description: "ล้างเวลาจริง/สถานะทั้งหมด กลับไปเริ่มใหม่ตั้งแต่ต้น",
      confirmText: "รีเซ็ต",
    });
    if (!ok) return;
    apply(
      ordered.map((r) => ({
        id: r.id,
        partial: {
          status: "pending",
          actual_start: null,
          actual_end: null,
          offset_min: null,
        },
      }))
    );
  }

  // Save the run-time report (planned vs actual, late/early, over/under per slot) as
  // a JPG to share with the crew after the show. Captures the off-screen report DOM.
  async function exportReport() {
    const el = reportRef.current;
    if (!el) return;
    setReportBusy(true);
    try {
      const safe = eventName.replace(/[^\w\-]+/g, "_") || "run-order";
      const how = await captureElementToImage(el, {
        filename: `${safe}_report.jpg`,
        shareTitle: `${eventName} — รายงานเวลา`,
        width: 720,
      });
      toast.success(how === "shared" ? "แชร์รายงานแล้ว" : "บันทึกรายงานแล้ว");
    } catch (e) {
      toast.error("บันทึกรายงานไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setReportBusy(false);
    }
  }

  // --- derived display --------------------------------------------------------
  const nowDate = new Date(now);
  const wall = formatClockOfDay(secOfDay(nowDate), true);

  const liveElapsed =
    liveRow?.actual_start != null
      ? Math.max(0, (now - Date.parse(liveRow.actual_start)) / 1000)
      : 0;
  const livePlannedDur =
    liveRow &&
    parseClockToSeconds(liveRow.planned_start) != null &&
    parseClockToSeconds(liveRow.planned_end) != null
      ? Math.max(
          0,
          parseClockToSeconds(liveRow.planned_end)! -
            parseClockToSeconds(liveRow.planned_start)!
        )
      : null;
  const liveRemaining =
    livePlannedDur != null ? livePlannedDur - liveElapsed : null;

  const nextProjSec = nextPending ? projectedStartSec(nextPending) : null;
  // Folded like the drift math — a past-midnight slot (00:30 seen at 23:50) must
  // count down 40 min, not read "ถึงคิวแล้ว" a day early.
  const nextCountdown =
    nextProjSec != null ? normSec(nextProjSec - secOfDay(nowDate)) : null;

  const driftTone =
    drift === 0 ? "ok" : drift > 0 ? "late" : "early";

  return (
    <div className="space-y-4">
      {/* Top bar: wall clock + overall drift */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-3">
          <Radio className="h-6 w-6 text-primary" />
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              เวลาขณะนี้
            </p>
            <p className="font-mono text-4xl font-bold leading-none tabular-nums sm:text-5xl">
              {mounted ? wall : "··:··:··"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mounted && doneRows.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={exportReport}
              disabled={reportBusy}
              title="บันทึกรายงานเวลาจริงเป็นรูป ไว้แชร์ให้ทีมงาน"
            >
              {reportBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImageDown className="h-4 w-4" />
              )}
              บันทึกรายงาน
            </Button>
          )}
          <Badge
            className={cn(
              "h-9 px-3 text-sm",
              driftTone === "ok" && "bg-success/15 text-success",
              driftTone === "late" && "bg-destructive/15 text-destructive",
              driftTone === "early" && "bg-sky-500/15 text-sky-600 dark:text-sky-400"
            )}
            variant="secondary"
          >
            {started ? driftPhrase(drift) : "ยังไม่เริ่มงาน"}
          </Badge>
        </div>
      </div>

      {/* NOW + NEXT */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* NOW */}
        <div
          className={cn(
            "rounded-xl border-l-4 bg-card p-4",
            liveRow ? kindMeta(liveRow.kind).rail : "border-l-transparent"
          )}
        >
          <p className="text-xs font-bold uppercase tracking-wide text-primary">
            ● ตอนนี้ (NOW)
          </p>
          {liveRow ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-2xl font-bold leading-tight">
                  {liveRow.title || "(ไม่มีชื่อ)"}
                </h2>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-2 py-0.5 text-xs font-bold",
                    kindMeta(liveRow.kind).chip
                  )}
                >
                  {kindMeta(liveRow.kind).label}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-4xl font-bold tabular-nums">
                  {mounted
                    ? `${Math.floor(liveElapsed / 60)}:${String(
                        Math.floor(liveElapsed % 60)
                      ).padStart(2, "0")}`
                    : "0:00"}
                </span>
                {mounted && liveRemaining != null && (
                  <span
                    className={cn(
                      "font-mono text-lg tabular-nums",
                      liveRemaining < 0 ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {liveRemaining < 0 ? "เกิน " : "เหลือ "}
                    {formatCountdown(Math.round(liveRemaining))}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                แผน{" "}
                {liveRow.planned_start
                  ? formatClockOfDay(parseClockToSeconds(liveRow.planned_start)!)
                  : "—"}
                {liveRow.planned_end
                  ? `–${formatClockOfDay(parseClockToSeconds(liveRow.planned_end)!)}`
                  : ""}{" "}
                · เริ่มจริง{" "}
                {mounted && liveRow.actual_start
                  ? formatClockOfDay(secOfDay(new Date(liveRow.actual_start)))
                  : "—"}{" "}
                {mounted && startLateMin(liveRow) != null && (
                  <span
                    className={cn(
                      "font-medium",
                      startLateMin(liveRow)! > 0
                        ? "text-destructive"
                        : startLateMin(liveRow)! < 0
                          ? "text-sky-600 dark:text-sky-400"
                          : "text-success"
                    )}
                  >
                    ({driftPhrase(startLateMin(liveRow)!)})
                  </span>
                )}
              </p>
              {liveRow.linked_event_id && (
                <Link
                  href={`/events/${liveRow.linked_event_id}/live`}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ListMusic className="h-3.5 w-3.5" /> เปิด setlist วงนี้
                </Link>
              )}
            </div>
          ) : (
            <p className="mt-3 text-muted-foreground">
              {started ? "จบงานแล้ว 🎉" : "ยังไม่เริ่ม — กด “เริ่มงาน”"}
            </p>
          )}
        </div>

        {/* NEXT */}
        <div
          className={cn(
            "rounded-xl border-l-4 bg-card p-4",
            nextPending ? kindMeta(nextPending.kind).rail : "border-l-transparent"
          )}
        >
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            ▸ ถัดไป (NEXT)
          </p>
          {nextPending ? (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-xl font-semibold leading-tight">
                  {nextPending.title || "(ไม่มีชื่อ)"}
                </h2>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-2 py-0.5 text-xs font-bold",
                    kindMeta(nextPending.kind).chip
                  )}
                >
                  {kindMeta(nextPending.kind).label}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                คาดเริ่ม{" "}
                <b className="text-foreground tabular-nums">
                  {nextProjSec != null ? formatClockOfDay(nextProjSec) : "—"}
                </b>
                {/* Clock-of-day countdown is only meaningful once the show runs —
                    pre-show it would falsely read "ถึงคิวแล้ว" (same gate as
                    event-run-status.tsx). */}
                {mounted &&
                  started &&
                  nextCountdown != null &&
                  (nextCountdown > 0 ? (
                    <> · อีก {formatCountdown(Math.round(nextCountdown))}</>
                  ) : (
                    <span className="text-destructive"> · ถึงคิวแล้ว</span>
                  ))}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-muted-foreground">— ไม่มีลำดับถัดไป —</p>
          )}
        </div>
      </div>

      {/* Controls (approvers only) */}
      {canControl ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            {liveRow ? (
              <Button size="lg" onClick={next} disabled={busy} className="text-base">
                {nextPending ? (
                  <>
                    <SkipForward className="h-5 w-5" /> จบ + ต่อไป
                  </>
                ) : (
                  <>
                    <Flag className="h-5 w-5" /> จบงาน
                  </>
                )}
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={start}
                disabled={busy || !firstPending}
                className="text-base"
              >
                <Play className="h-5 w-5" />
                {started ? "เริ่มลำดับถัดไป" : "เริ่มงาน"}
              </Button>
            )}

            {/* time push — adjust drift on the live row */}
            <div className="flex items-center gap-1 rounded-lg border p-1">
              <Button variant="ghost" size="sm" disabled={!liveRow || busy} onClick={() => adjust(-5)}>
                <Minus className="h-3.5 w-3.5" />5
              </Button>
              <Button variant="ghost" size="sm" disabled={!liveRow || busy} onClick={() => adjust(-1)}>
                <Minus className="h-3.5 w-3.5" />1
              </Button>
              <span className="px-1 text-xs text-muted-foreground">นาที</span>
              <Button variant="ghost" size="sm" disabled={!liveRow || busy} onClick={() => adjust(1)}>
                <Plus className="h-3.5 w-3.5" />1
              </Button>
              <Button variant="ghost" size="sm" disabled={!liveRow || busy} onClick={() => adjust(5)}>
                <Plus className="h-3.5 w-3.5" />5
              </Button>
            </div>

            <Button variant="outline" size="sm" disabled={!liveRow || busy} onClick={takeBuffer}>
              <Hand className="h-4 w-4" /> ดึง buffer
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={!started || busy}
              onClick={resetAll}
              className="ml-auto text-muted-foreground"
            >
              <RotateCcw className="h-4 w-4" /> รีเซ็ต
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            “จบ + ต่อไป” = ปิดลำดับนี้ (บันทึกเวลาจริง) แล้วเริ่มลำดับถัดไปทันที · ±นาที =
            เลื่อนคิวข้างหน้า · ดึง buffer = ร่นเวลาให้ทันเมื่อช้า
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
          กำลังดูแบบอ่านอย่างเดียว — เฉพาะสตาฟ (แอดมิน/ทีมค่าย) คุมคิวได้
        </p>
      )}

      {/* Full board */}
      <div className="space-y-1.5">
        {ordered.length === 0 ? (
          <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีลำดับงาน — สร้างที่ Running Order ก่อน
          </p>
        ) : (
          ordered.map((r) => {
            const meta = kindMeta(r.kind);
            const proj = projectedStartSec(r);
            const isLive = r.status === "live";
            const isDone = r.status === "done";
            return (
              <div
                key={r.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-l-4 bg-card p-2.5",
                  meta.rail,
                  isLive && "ring-2 ring-primary",
                  isDone && "opacity-60"
                )}
              >
                {/* time */}
                <div className="w-[4.5rem] shrink-0 text-center">
                  {isDone && r.actual_start && mounted ? (
                    <span className="font-mono text-sm font-semibold tabular-nums text-muted-foreground">
                      {formatClockOfDay(secOfDay(new Date(r.actual_start)))}
                    </span>
                  ) : proj != null ? (
                    <span
                      className={cn(
                        "font-mono text-sm font-semibold tabular-nums",
                        isLive && "text-primary"
                      )}
                    >
                      {formatClockOfDay(proj)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                  {r.planned_start && proj != null && drift !== 0 && !isDone && (
                    <span className="block font-mono text-[10px] text-muted-foreground line-through tabular-nums">
                      {formatClockOfDay(parseClockToSeconds(r.planned_start)!)}
                    </span>
                  )}
                </div>

                {/* title + kind */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {r.title || "(ไม่มีชื่อ)"}
                  </p>
                  <span
                    className={cn(
                      "mt-0.5 inline-block rounded px-1.5 text-[10px] font-bold",
                      meta.chip
                    )}
                  >
                    {meta.label}
                  </span>
                </div>

                {/* status / log */}
                <div className="shrink-0 text-right">
                  {isLive ? (
                    <Badge className="gap-1 bg-primary text-primary-foreground">
                      <Radio className="h-3 w-3" /> LIVE
                    </Badge>
                  ) : isDone ? (
                    (() => {
                      const log = mounted ? startLateMin(r) : null;
                      const dur = mounted ? durationDeltaMin(r) : null;
                      return (
                        <div className="flex flex-col items-end gap-0.5">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-xs font-medium",
                              log == null
                                ? "text-muted-foreground"
                                : log > 0
                                  ? "text-destructive"
                                  : log < 0
                                    ? "text-sky-600 dark:text-sky-400"
                                    : "text-success"
                            )}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {log == null ? "เสร็จ" : driftPhrase(log)}
                          </span>
                          {dur != null && dur !== 0 && (
                            <span
                              className={cn(
                                "text-[10px] font-medium tabular-nums",
                                dur > 0
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                              )}
                            >
                              {durPhrase(dur)}
                            </span>
                          )}
                        </div>
                      );
                    })()
                  ) : r.buffer_seconds > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      buffer {Math.round(r.buffer_seconds / 60)}น.
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Off-screen run-time report — captured to a clean JPG by exportReport().
          Mounted-only (never in the SSR HTML) so its timezone-dependent actual times
          can't cause a hydration mismatch; captureElementToImage forces a light
          palette + fixed width when it shoots it. */}
      {mounted && doneRows.length > 0 && (
        <div
          ref={reportRef}
          aria-hidden
          className="pointer-events-none fixed -left-[9999px] top-0 w-[720px] bg-card p-6 text-foreground"
        >
          <div className="mb-4">
            <h2 className="text-xl font-bold">{eventName}</h2>
            <p className="text-sm text-muted-foreground">
              {eventDate ? `${eventDate} · ` : ""}รายงานเวลาจริง (Run-time Report)
            </p>
            <p className="mt-1 text-sm">
              ภาพรวม:{" "}
              <b>{started ? driftPhrase(drift) : "—"}</b>
            </p>
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">ลำดับ</th>
                <th className="py-1.5 pr-2 font-medium">แผน</th>
                <th className="py-1.5 pr-2 font-medium">จริง</th>
                <th className="py-1.5 pr-2 font-medium">เริ่ม</th>
                <th className="py-1.5 pr-2 font-medium">เล่น</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => {
                const ps = parseClockToSeconds(r.planned_start);
                const pe = parseClockToSeconds(r.planned_end);
                const planned =
                  ps != null
                    ? `${formatClockOfDay(ps)}${pe != null ? `–${formatClockOfDay(pe)}` : ""}`
                    : "—";
                const actual = r.actual_start
                  ? `${formatClockOfDay(secOfDay(new Date(r.actual_start)))}${
                      r.actual_end
                        ? `–${formatClockOfDay(secOfDay(new Date(r.actual_end)))}`
                        : ""
                    }`
                  : "—";
                const late = startLateMin(r);
                const dur = durationDeltaMin(r);
                return (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">{r.title || "(ไม่มีชื่อ)"}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {kindMeta(r.kind).label}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                      {planned}
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">{actual}</td>
                    <td className="py-1.5 pr-2 text-xs">
                      {late == null ? "—" : driftPhrase(late)}
                    </td>
                    <td className="py-1.5 pr-2 text-xs">
                      {dur == null ? "—" : durPhrase(dur)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-[11px] text-muted-foreground">
            สร้างจาก CueIQ · {eventName}
          </p>
        </div>
      )}
    </div>
  );
}
