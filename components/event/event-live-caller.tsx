"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Play,
  SkipForward,
  Flag,
  RotateCcw,
  Timer,
  Radio,
  CheckCircle2,
  Hand,
  ListMusic,
  ImageDown,
  Loader2,
  ChevronLeft,
  Coffee,
  Music,
  Gamepad2,
  Award,
  Mic,
  CircleDot,
  OctagonAlert,
  TriangleAlert,
  CloudOff,
  Eye,
  Hourglass,
  FastForward,
  CircleDashed,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { notify } from "@/lib/notify-client";
import { captureElementToImage, safeFileStem } from "@/lib/export-image";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Countdown } from "@/components/live/countdown";
import { OfflineBanner } from "@/components/offline-banner";
import { StageLight } from "@/components/stage-light";
import { useAccountPanel } from "@/components/account-panel";
import { cn } from "@/lib/utils";
import { bandLitVars, bandTriplet } from "@/lib/band-triplet";
import { privateChannel, runOrderTopic } from "@/lib/realtime";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";
import {
  applyRunSeqOverlay,
  discardRunSeqOp,
  enqueueRunSeq,
  flushRunSeqOutbox,
  foreignRunSeqRows,
  listRunSeqOps,
  newRunSeqPressId,
  onRunSeqOutboxChange,
  RUNSEQ_LANDED_EVENT,
  RUNSEQ_QUEUED_MESSAGE,
  type RunSeqLanded,
  type RunSeqOp,
} from "@/lib/run-order-outbox";
import { compareRunOrder } from "@/lib/run-order-sort";
import { NOT_SHOW_TIME_MESSAGE } from "@/lib/show-time-window";
import {
  formatClockOfDay,
  formatCountdown,
  formatDuration,
  formatOvertime,
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

// Icon + label + rail per kind, so a staffer can read the board at a glance. Same
// kinds the builder offers. Tokens only (spec §G.11): a band act takes the band
// colour, everything else is neutral and told apart by its icon and word — the
// break is a DASHED neutral rail + Coffee, never amber, which is the warning
// ladder's colour. The labels are printed on the JPG report too: keep them as is.
const KIND_META: Record<
  string,
  { label: string; icon: LucideIcon; en?: boolean; rail: string; chip: string }
> = {
  band: { label: "วง", icon: Music, rail: "bg-primary", chip: "chip-primary" },
  game: { label: "เกม", icon: Gamepad2, rail: "bg-foreground/35", chip: "chip-neutral" },
  ceremony: { label: "พิธี", icon: Award, rail: "bg-foreground/35", chip: "chip-neutral" },
  mc: { label: "MC", icon: Mic, en: true, rail: "bg-foreground/35", chip: "chip-neutral" },
  break: {
    label: "Break",
    icon: Coffee,
    en: true,
    rail: "border-l-4 border-dashed border-foreground/35 bg-transparent",
    chip: "chip-neutral",
  },
  other: { label: "อื่นๆ", icon: CircleDot, rail: "bg-foreground/20", chip: "chip-neutral" },
};
// a cached row can come without `kind` at all — it reads as "other"
const kindMeta = (k: string | null | undefined) => KIND_META[k ?? ""] ?? KIND_META.other;

/** The kind as a chip: icon + word. English kinds (MC, Break) set in display caps. */
function RunKindChip({ kind }: { kind: string | null | undefined }) {
  const m = kindMeta(kind);
  const Icon = m.icon;
  return (
    <span className={cn("chip flex-none", m.chip, m.en && "en")}>
      <Icon aria-hidden />
      {m.label}
    </span>
  );
}

/** Late = warning, early = info, on time = success — the drift chips' inks. */
const toneInk = (min: number) =>
  min > 0 ? "text-warning-ink" : min < 0 ? "text-info-ink" : "text-success-ink";

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

/** How long the caller's own row write may go unanswered before the press is queued
 *  instead (2026-10-27, see apply()). The desktop's read budget for this same board
 *  (RUN_ORDER_TIMEOUT_MS in desktop/src/data/run-order.ts), which this shared component
 *  cannot import: slow still gets to commit, never-answering no longer holds the dock. */
export const CALLER_WRITE_TIMEOUT_MS = 8000;

/** A drift (minutes, late + / early −) as a short Thai phrase. */
function driftPhrase(min: number): string {
  if (min === 0) return "ตรงเวลา";
  return min > 0 ? `ช้า +${min} น.` : `เร็ว ${-min} น.`;
}

/** The caller's way into the account panel (Feedback, Dark/Light, Fullscreen). This
 *  route has no app header and no tab bar — the two things that open that panel
 *  everywhere else — so before this the board had no แจ้งปัญหา, no theme switch for
 *  a sunlit stage and no fullscreen, all of which the header carried before the
 *  redesign. The panel is the shell's own (web layout and desktop shell both mount
 *  it here), so a report records THIS page. No leave guard here, so its links and
 *  sign-out are as safe as anywhere. */
function CallerMenuButton() {
  const { open, setOpen } = useAccountPanel();
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="เมนู: แจ้งปัญหา · ธีม · เต็มจอ"
      title="แจ้งปัญหา · ธีม · เต็มจอ"
      className="grid h-11 w-11 flex-none place-items-center rounded-[3px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MoreHorizontal className="h-6 w-6" aria-hidden />
    </button>
  );
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
  backHref,
  backLabel,
  notice,
  onRows,
}: {
  tenantId: string;
  eventName: string;
  eventDate: string | null;
  /** The event the board was opened for — anchors the "show is live" notification. */
  eventId: string;
  initial: RunSeqLive[];
  /** Approvers (admin + label_staff) run the show; everyone else watches read-only. */
  canControl: boolean;
  /** The way back. This route is immersive (no app header), so the caller's own top
   *  bar carries it; the page decides where it goes (builder / event / Overview). */
  backHref?: string;
  backLabel?: string;
  /** A page-level notice (the desktop's "this is a saved copy") shown first in the
   *  content, under the top bar. */
  notice?: ReactNode;
  /**
   * Called with the rows the SERVER now holds, each time the board learns them: a
   * refetch it applied, or a press that committed. Never with the queue's overlay -
   * still-queued presses are laid back over whatever the board renders anyway, and a
   * copy that baked them in would show a press that later parks as if it had landed.
   * The desktop writes its offline read-cache from this: written only at page load,
   * that cache rewound the board to page-open state after a navigation or a restart
   * during an outage (2026-10-26).
   *
   * `source` says how the board learned them: "read" = a refetch it applied, i.e. the
   * whole board as the server holds it now; "write" = a press that committed, laid onto
   * the rows of the last read. Only a "read" proves the board matches the other devices -
   * the desktop's "this is an offline copy" notice comes down on that, never on a press
   * that got through a link the board's own re-read cannot (2026-10-27).
   */
  onRows?: (rows: RunSeqLive[], source: "read" | "write") => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const confirm = useConfirm();
  const [rows, setRows] = useState<RunSeqLive[]>(initial);
  // What the SERVER holds, as far as this board knows: the last refetch it applied,
  // plus every write that came back committed. `rows` cannot stand in for it - it
  // carries every optimistic press, the queued ones included. Read only for onRows.
  const serverRowsRef = useRef<RunSeqLive[]>(initial);
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  function serverHolds(next: RunSeqLive[], source: "read" | "write") {
    serverRowsRef.current = next;
    try {
      onRowsRef.current?.(next, source);
    } catch {
      /* a page's copy of the board must never break the press that produced it */
    }
  }
  // ...and every queued press the FLUSH lands is a write the server now holds too
  // (2026-10-27). This ref used to learn such a press only from the re-read that follows
  // it, so on venue wifi that lets the flush's writes through but drops the board's
  // SELECT, it kept the rows from BEFORE the landed press. The desktop's offline copy had the
  // press (run-order.ts lays every landing onto it), but the very next press that
  // committed online wrote the copy again from here: "จบ + ต่อไป" rewound, the act it
  // ended live again in the copy, and opened offline later the board offered it as NOW.
  // The ref only - the copy is laid already, and `rows` is not touched: the clear-the-way
  // flush in apply() lands a row's OLDER queued press while the board shows the newer
  // one it is about to send.
  useEffect(() => {
    const onLanded = (e: Event) => {
      const landed = (e as CustomEvent<RunSeqLanded>).detail;
      if (!landed?.rowId || !landed.patch) return;
      if (!serverRowsRef.current.some((r) => r.id === landed.rowId)) return; // another board's row
      serverRowsRef.current = serverRowsRef.current.map((r) =>
        r.id === landed.rowId ? { ...r, ...landed.patch } : r
      );
    };
    window.addEventListener(RUNSEQ_LANDED_EVENT, onLanded);
    return () => window.removeEventListener(RUNSEQ_LANDED_EVENT, onLanded);
  }, []);
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

  // Presses this device made with no network. A board that silently holds unsent
  // moves looks identical to one that is in sync — and at a festival that is the
  // difference between "we are fine" and "nobody downstream knows we ran late".
  const [queued, setQueued] = useState<RunSeqOp[]>([]);
  // How many presses were still WAITING (un-parked) at the last read here (refetch()
  // re-reads it too) - a read that finds fewer means presses landed or parked since.
  const queueCountRef = useRef(-1);
  const waitingCount = (ops: RunSeqOp[]) => ops.filter((o) => !o.conflict).length;
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listRunSeqOps().then((ops) => {
        if (!alive) return;
        setQueued(ops);
        // The queue SHRANK, so a flush just landed (or parked) presses the server
        // had never seen. Re-read the board: on a clean flush this confirms server
        // truth and picks up whatever the other devices did meanwhile; on a park it
        // is the only way the operator gets to see what the server actually holds
        // before deciding. Safe now that the overlay re-applies anything still
        // queued — before it, this refetch is exactly what would have wiped the
        // operator's own presses off the screen.
        // un-parked presses only: a press that PARKS stays in the store (conflict: true), so
        // counting every record never saw it leave the overlay - the board kept showing
        // it as if it had landed (2026-10-26, ตาที่ 3)
        const n = waitingCount(ops);
        const shrank = queueCountRef.current >= 0 && n < queueCountRef.current;
        queueCountRef.current = n;
        if (shrank) refetchRef.current();
      });
    };
    refresh();
    // the outbox announces every queue change, including the flush that empties it,
    // so the chip disappears the moment the moves have landed - and the same word
    // from ANOTHER TAB of this browser, which drains the same IndexedDB with its own
    // OutboxFlusher and used to announce to its own window only (2026-10-26)
    const off = onRunSeqOutboxChange(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);
  // The queue is ONE store for every festival this device has ever called, and a
  // press parked at last week's show stays until someone taps ทิ้ง. The banners name
  // only THIS board's presses: another festival's red alarm told the operator to
  // check "the board below", which held no such press (2026-10-26). A press is this
  // board's when its row is on it or it names this board's topic; a record older
  // than topics that names neither cannot be placed, so it is still shown.
  const boardTopic = runOrderTopic(tenantId, eventDate, eventName);
  const boardRowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const onThisBoard = (o: RunSeqOp) =>
    boardRowIds.has(o.rowId) || !o.topic || o.topic === boardTopic;
  const parked = queued.filter((o) => o.conflict && onThisBoard(o));
  // Unfiltered on purpose: apply()'s queued-row check must see every un-parked press
  // there is - another account's too, so a press on its rows folds into it (mergeOp).
  const unparked = queued.filter((o) => !o.conflict);
  // ...but the overlay and the banner only what a flush HERE sends (2026-10-30, hunt 11):
  // another account's presses wait for that account (foreignRunSeqRows), and laid over the
  // rows they showed this account a board the server and every other device never had.
  const foreignRows = useMemo(() => foreignRunSeqRows(queued), [queued]);
  const waiting = unparked.filter((o) => !foreignRows.has(o.rowId));
  const waitingHere = waiting.filter(onThisBoard);
  const foreignHere = unparked.filter((o) => foreignRows.has(o.rowId) && onThisBoard(o));

  // Server rows are only the truth for presses the server has SEEN. Anything
  // still in the queue happened on this device and nowhere else, so it is laid
  // back over every set of rows the board renders — whatever their source.
  //
  // Three separate ways the board used to lose those presses, all closed here:
  // a reconnect refetch resolving before the flush replayed anything (both fire
  // on 'online', and one SELECT beats N round trips every time); the desktop
  // remounting from its read cache after a restart at the venue; and any refetch
  // a broadcast triggers while the queue is still full.
  const ordered = useMemo(
    () => [...applyRunSeqOverlay(rows, waiting)].sort(compareRunOrder),
    [rows, waiting]
  );
  const liveRow = ordered.find((r) => r.status === "live") ?? null;
  const livePos = liveRow ? ordered.indexOf(liveRow) : -1;
  const doneRows = ordered.filter((r) => r.status === "done");
  const lastDone = doneRows.length ? doneRows[doneRows.length - 1] : null;
  // current drift = the live row's, else the last finished row's, else on-time.
  const drift = liveRow?.offset_min ?? lastDone?.offset_min ?? 0;
  // The first pending row AFTER the live one by POSITION. "A higher sort_order than
  // the live row" skipped an act sharing the live row's number - two rows can tie
  // (lib/run-order-sort.ts) - and the key read "จบ + ต่อไป · Seishin" while "Game"
  // was still waiting (2026-10-26).
  const nextPending = ordered.slice(livePos + 1).find((r) => r.status === "pending") ?? null;
  const firstPending = ordered.find((r) => r.status === "pending") ?? null;
  const started = ordered.some((r) => r.status !== "pending");

  // Each band act's OWN colour (spec §G.11) — several bands share this board, and the
  // device's band light on another band's act names the wrong band. run_sequence has
  // no band column, only the band's EVENT (linked_event_id), so the board asks
  // events → groups once per set of linked acts. Presentation only: it is not part of
  // the rows, the refetch or the realtime channel. A read that fails (offline, RLS) or
  // a band with no colour leaves that act on the device's own light, as before.
  const linkedKey = useMemo(
    () =>
      [...new Set(rows.map((r) => r.linked_event_id).filter((v): v is string => !!v))]
        .sort()
        .join(","),
    [rows]
  );
  const [actColors, setActColors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!linkedKey) return;
    let alive = true;
    Promise.resolve(
      supabase.from("events").select("id, groups(color)").in("id", linkedKey.split(","))
    )
      .then(({ data }) => {
        if (!alive || !data) return;
        const next: Record<string, string> = {};
        for (const e of data as { id: string; groups: unknown }[]) {
          const g = (Array.isArray(e.groups) ? e.groups[0] : e.groups) as
            | { color?: string | null }
            | null
            | undefined;
          if (g?.color) next[e.id] = g.color;
        }
        setActColors(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [supabase, linkedKey]);
  /** A band act's own colour, when the board knows it (a cached row can lack the link). */
  const actColor = (r: RunSeqLive | null) =>
    r?.kind === "band" && r.linked_event_id ? actColors[r.linked_event_id] : undefined;
  const liveColor = actColor(liveRow);

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
  // Ordering guard (same idea as the setlist refetch in live-mode.tsx): a broadcast
  // can fire a refetch at any moment — including one already reading the board when
  // the operator presses "จบ + ต่อไป". Without this, that older snapshot resolves
  // AFTER our write and reverts the board to the pre-advance state, mid-show, on the
  // one screen that is authoritative. `refetchSeq` drops superseded snapshots,
  // `writesInFlight` defers a refetch issued while our own write is un-acked, and
  // `missedRefetch` makes apply() re-pull whatever we skipped.
  const refetchSeqRef = useRef(0);
  const writesInFlightRef = useRef(0);
  const missedRefetchRef = useRef(false);
  // Bumped around every press this board queues itself (queueOffline). ดึง buffer queues
  // its drains AFTER apply() has returned, with no refetchSeq bump: a refetch already in
  // flight had read the queue without them and laid that older queue over the fresh one,
  // so the spent buffers showed again (2026-10-27). Such a read starts over instead.
  const queueEpochRef = useRef(0);

  /**
   * Pull the board back to what the server says.
   *
   * 🔎 REPORTS WHAT ACTUALLY HAPPENED (round 10), because apply()'s error path makes a
   * PROMISE about it: it tells the operator the board was corrected. During an outage the
   * read fails for the same reason the write did, so that promise was a sentence and
   * nothing else while the screen kept showing an advanced row no other device agreed with.
   *
   * ⚠️ THREE OUTCOMES, NOT TWO. The first version returned a boolean and the caller read
   * every `false` as "the read failed" — but two of the three early returns below are
   * ORDINARY SUCCESS PATHS. Deferring behind our own in-flight write sets `missedRefetch`
   * and the board is pulled correctly a moment later; a snapshot superseded by a newer
   * refetch is dropped precisely so the newer one can land. Warning on those meant a red
   * "บันทึกไม่สำเร็จ" followed by an untrue amber "the board may not match" — mid-show, on
   * the authoritative festival screen, inviting a needless reload of the one device driving
   * the running order. Only `"failed"` means nobody is going to fix this by themselves.
   */
  type RefetchOutcome = "applied" | "deferred" | "failed";

  async function refetch(): Promise<RefetchOutcome> {
    if (writesInFlightRef.current > 0) {
      // anything we read now can be pre-write — apply() re-pulls once it commits
      missedRefetchRef.current = true;
      return "deferred";
    }
    const seq = ++refetchSeqRef.current;
    const epoch = queueEpochRef.current;
    missedRefetchRef.current = false;
    // The queue is read BEFORE the rows (see the note at setQueued below for why it is
    // read at all). Read after them, a flush landing between the two reads left rows
    // from BEFORE it with a queue from AFTER it: the landed press was neither on the
    // rows nor laid over them, the board showed the act it had already ended as NOW,
    // and the shrink the flush announced was swallowed (queueCountRef already said 0) -
    // no re-read came (2026-10-26, ตาที่ 3). Queue first: a press still queued is laid
    // over rows that may already hold it (same values), never missing from both.
    const ops = await listRunSeqOps();
    let q = supabase
      .from("run_sequence")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("event_name", eventName)
      .order("sort_order", { ascending: true });
    q = eventDate ? q.eq("event_date", eventDate) : q.is("event_date", null);
    const { data } = await q;
    // a newer refetch — or a local write — was issued while this was in flight:
    // drop this older snapshot and let apply()'s tail pull a fresh one
    if (seq !== refetchSeqRef.current) {
      // superseded — the newer refetch is the one that will land. Not a failure.
      missedRefetchRef.current = true;
      return "deferred";
    }
    if (!data) return "failed";
    // `data: [], error: null` is also what RLS answers an ANON request with, and
    // supabase-js falls back to the anon key for the minute after a failed token
    // refresh — the same minute a backgrounded phone comes back and this refetch
    // fires on wake/reconnect. Blanking the running order on the one screen the
    // whole festival is called from is not a risk worth an unverified read.
    // An unverifiable empty answer is a read we could not trust — that IS a failure.
    if (data.length === 0 && rows.length > 0 && !(await hasLiveSession())) return "failed";
    // This board queued a press while the read was out: `ops` predates it. Read again
    // (queue first, as above) rather than lay a queue without it over the board.
    if (epoch !== queueEpochRef.current) return refetch();
    // Re-read the queue WITH the rows: the overlay lays every queued press over them,
    // and a press that is no longer queued must not be. Another tab of this browser
    // drains the same IndexedDB, and this board heard only its OWN window's word - so
    // it kept painting presses that had landed, put the act that already finished
    // back on stage once the show moved on, and the next press built on that board
    // put a second act live (2026-10-26). A refetch is when the board takes the
    // server's word, so the queue's word is taken in the same breath.
    setQueued(ops);
    queueCountRef.current = waitingCount(ops);
    setRows(data as RunSeqLive[]);
    serverHolds(data as RunSeqLive[], "read");
    return "applied";
  }
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    const ch = privateChannel(
      supabase,
      runOrderTopic(tenantId, eventDate, eventName)
    );
    ch.on("broadcast", { event: "changed" }, ({ payload }) => {
      if (payload?.sender !== meId.current) refetchRef.current();
    });
    // A broadcast only reaches whoever is listening at that moment, and iOS
    // suspends a backgrounded tab's socket within seconds — so a show-caller who
    // locked their phone for one act came back to a board that had silently missed
    // every change since. Re-ask the server on (re)connect, on returning to the
    // foreground, and when the network comes back. refetch() already defers against
    // its own in-flight writes, so extra calls are safe.
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") refetchRef.current();
    });
    const onWake = () => {
      if (document.visibilityState === "visible") refetchRef.current();
    };
    const onOnline = () => refetchRef.current();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onOnline);
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onOnline);
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
    /** Thai label for the offline queue's chip / conflict list. */
    label?: string;
    /** the show's first start: if it is queued, the label is told once its replay lands */
    announceLive?: string;
    /** A start: the planned_start its offset_min was worked out against (null = the drift
     *  did not come from the plan). Rides the queue so a re-plan made while the press
     *  waits moves the drift with it (RunSeqOp.planBasis, lib/run-order-outbox.ts). */
    planBasis?: string | null;
  };

  /**
   * The write didn't go out because there is no network. Keep the operator's press
   * — the show is happening whether or not the wifi is — and replay it later.
   *
   * "rejected" for a REAL rejection (RLS, a constraint), which must still surface:
   * queueing those would retry a doomed write forever. "unsaved" when this device's
   * storage refused the queue write (a full disk, a broken store): the press is on this
   * screen and nowhere else, so it must never be announced as queued - that toast
   * promised a sync that could not happen (2026-10-27, hunt 6).
   */
  type QueueOutcome = "queued" | "rejected" | "unsaved";
  /** The press id queueOffline() last gave out - ดึง buffer's drains join its drift's. */
  const lastQueuedPressRef = useRef<string | null>(null);
  async function queueOffline(
    updates: CallerUpdate[],
    message: string | null | undefined,
    // Set when the press must be queued regardless of WHY — see apply()'s
    // already-queued branch. There was no network error to classify: the press is
    // simply not something the server can be asked about yet.
    force = false,
    /* The PostgrestResponse's HTTP status, when the caller has one. Round 10: without
       it a Supabase/Cloudflare 503 or 429 was read as a REAL REJECTION, because those
       arrive as an HTML page whose text matches none of the network words — so the
       operator's press was neither written nor queued while the row was already
       advanced on screen. See lib/mgmt-outbox.ts for the full account. */
    status?: number | null,
    // The press these rows belong to, when they continue one already queued (ดึง
    // buffer's drains after its drift). Otherwise this call IS one press.
    press?: string
  ): Promise<QueueOutcome> {
    const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!force && !isQueueableWriteError(message, onLine, status)) return "rejected";
    const festival = `${eventName}${eventDate ? ` · ${eventDate}` : ""}`;
    const at = Date.now();
    // Every row of ONE press carries the same id, so the replay lands the press whole
    // or parks it whole: "จบ + ต่อไป" replayed row by row put its next act live while
    // the act it ended had already been moved by another device - two acts live at
    // once, and the one after was never called (lib/run-order-outbox.ts, 2026-10-26).
    const pressId = press ?? newRunSeqPressId();
    lastQueuedPressRef.current = pressId;
    // before AND after the enqueues: a read that starts between two of them saw half
    queueEpochRef.current++;
    let stored = true;
    try {
      for (const u of updates) {
        const kept = await enqueueRunSeq({
          rowId: u.id,
          presses: [pressId],
          festival,
          // Only the caller's own columns ride the queue — never the plan, which
          // belongs to the builder and must not be replayed over.
          patch: {
            status: u.partial.status,
            actual_start: u.partial.actual_start,
            actual_end: u.partial.actual_end,
            offset_min: u.partial.offset_min,
            buffer_seconds: u.partial.buffer_seconds,
          },
          // Carry EVERY precondition the online write used, not just the two the
          // status buttons set. ดึง buffer's drains are conditional on the
          // buffer_seconds they read (see takeBuffer) — replaying them guarded only
          // by status='pending' would write a stale absolute value straight over a
          // buffer another controller had already spent.
          expect: {
            status: u.expect?.status,
            offset_min: u.expect?.offset_min,
            buffer_seconds: u.expect?.buffer_seconds,
          },
          label: u.label ?? rows.find((r) => r.id === u.id)?.title ?? "ลำดับในคิว",
          queuedAt: at,
          ...(u.announceLive ? { announceLive: { eventId: u.announceLive, at } } : {}),
          ...(u.planBasis !== undefined ? { planBasis: u.planBasis } : {}),
          topic: runOrderTopic(tenantId, eventDate, eventName),
        });
        if (!kept) stored = false;
      }
    } finally {
      queueEpochRef.current++;
    }
    return stored ? "queued" : "unsaved";
  }

  /** The press is on this screen only: say so. The callers then pull the board back to
   *  the server where it can be read (offline it cannot - the toast is the whole truth). */
  function sayUnsaved() {
    toast.error("เก็บการกดไว้ในเครื่องไม่สำเร็จ", {
      id: "runseq-offline-unsaved",
      description: "การกดนี้ยังไม่ถูกบันทึกที่ไหนเลย — พื้นที่เครื่องอาจเต็ม · กดใหม่อีกครั้งเมื่อเน็ตกลับมา",
    });
  }

  /**
   * Optimistically apply, persist each changed row, then tell other devices.
   *
   * Three outcomes, and callers that chain writes MUST tell them apart:
   *  • "committed" — the server holds it.
   *  • "queued"    — kept on this device, replays later. The press is safe, but
   *                  nothing downstream may assume the server agrees yet: ดึง
   *                  buffer drains and รีเซ็ต's ledger clear both corrupted the
   *                  plan when a boolean let them read this as committed.
   *  • "failed"    — nothing landed; the board was pulled back to server truth.
   */
  type ApplyResult = "committed" | "queued" | "failed";
  async function apply(updates: CallerUpdate[]): Promise<ApplyResult> {
    if (!canControl || updates.length === 0) return "failed";
    // invalidate any snapshot already in flight — it predates this write
    refetchSeqRef.current++;
    setRows((prev) =>
      prev.map((r) => {
        const u = updates.find((x) => x.id === r.id);
        return u ? { ...r, ...u.partial } : r;
      })
    );
    // The gate goes up HERE, before anything is awaited — not just around the
    // UPDATE. The clear-the-way flush below announces per op, the caller refetches
    // when the queue shrinks, and with the gate still down that SELECT went out
    // BEFORE our own write and then landed on top of it: the operator watched
    // their press disappear from the one screen the festival is called from.
    // Every exit from here on must release it.
    writesInFlightRef.current++;
    setBusy(true);
    const release = () => {
      writesInFlightRef.current--;
      setBusy(false);
      // a refetch was deferred by the gate — pull it now that we are settled
      if (missedRefetchRef.current) refetchRef.current();
    };

    // A row with a press still in the queue CANNOT be written directly, even with
    // the network back. Every press is a compare-and-swap, and the state this one
    // branched from is the state the QUEUE created — which the server has never
    // seen. Sending it would match zero rows while a sibling write in the same
    // press lands, and the board would end up with two rows live at once: the
    // queued op sets B live later, the direct write already set C live.
    //
    // Queueing it instead is not a fallback, it is the correct semantics: mergeOp
    // folds this press into the existing op, keeping the FIRST precondition (the
    // last server state anyone actually observed) and the LATEST value of each
    // column. The whole sequence then replays as one coherent write.
    let queuedRowIds = new Set(unparked.map((o) => o.rowId));
    if (updates.some((u) => queuedRowIds.has(u.id))) {
      // Try to clear the way first. Otherwise a queue that failed its one
      // reconnect attempt (the flush refuses to judge anything without a proven
      // session, and 'online' fires inside the anon minute) would make every
      // later press queue too — the board would go local-only for the rest of
      // the festival while the network was perfectly fine.
      if (typeof navigator === "undefined" || navigator.onLine !== false) {
        // BOUNDED: doFlush is one round trip per queued op with no timeout, and
        // on a venue link that has associated but has no upstream each of them
        // hangs. Unbounded, a queue of five would hold the operator's press in
        // memory for minutes — unsaved, unqueued, and lost if the machine goes
        // down. Past the deadline we simply queue this press, which is what the
        // slow path was going to conclude anyway.
        await Promise.race([
          flushRunSeqOutbox().catch(() => undefined),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
        queuedRowIds = new Set(
          (await listRunSeqOps()).filter((o) => !o.conflict).map((o) => o.rowId)
        );
      }
    }
    if (updates.some((u) => queuedRowIds.has(u.id))) {
      // finally, not a plain call: a throw anywhere in here would leave the write
      // gate up for the rest of the session, and with it every refetch deferred —
      // the board would quietly stop taking updates from the other devices.
      let kept: QueueOutcome = "unsaved";
      try {
        kept = await queueOffline(updates, null, true);
        if (kept === "queued") {
          toast.success(RUNSEQ_QUEUED_MESSAGE, { id: "runseq-offline-queued" });
          bcast();
        } else sayUnsaved();
      } finally {
        release();
      }
      if (kept === "queued") return "queued";
      void refetchRef.current(); // a press kept nowhere must not stay on the board
      return "failed";
    }

    // BOUNDED too (2026-10-27) - the press itself, not only the clear-the-way flush above.
    // supabase-js has no fetch timeout, and on venue wifi that has associated but has no
    // upstream (navigator.onLine TRUE, nothing ever answers) this await sat until the
    // browser gave up on the socket - about a minute on iOS, minutes on Android. The press
    // was neither committed nor queued, `busy` held every dock key disabled, inFlightRef
    // swallowed every จบ + ต่อไป, and a reload lost the press. Past the deadline the
    // request is cut and the press is queued, exactly as the already-queued branch above
    // does. The cut write may still have reached the server first; that is harmless:
    // every row write is a compare-and-swap, and the replay counts a row that already
    // holds the patch - or an earlier version of it, when a later press merged in - as
    // this press, done (patchAlreadyHolds / earlierPatchHeld, lib/run-order-outbox.ts).
    // Its late answer is never read: the race has settled, so nothing below runs for it
    // and the gate is released exactly once.
    const cut = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CALLER_WRITE_TIMEOUT_MS);
    });
    const write = Promise.all(
      updates.map((u) => {
        let q = supabase.from("run_sequence").update(u.partial).eq("id", u.id);
        for (const [k, v] of Object.entries(u.expect ?? {})) {
          q = v == null ? q.is(k, null) : q.eq(k, v);
        }
        // select the row back: 0 rows = deleted or precondition lost the race
        return q.select("id").abortSignal(cut.signal);
      })
    );
    let answer: Awaited<typeof write> | "timeout" | undefined;
    try {
      answer = await Promise.race([write, deadline]);
    } finally {
      clearTimeout(timer);
      // clear the write gate even if the round-trip threw, or refetch stays deferred -
      // but not on the deadline: that press still has to be queued, and is released below
      if (answer !== "timeout") {
        writesInFlightRef.current--;
        setBusy(false);
      }
    }
    if (answer === "timeout") {
      cut.abort();
      let kept: QueueOutcome = "unsaved";
      try {
        kept = await queueOffline(updates, null, true);
        if (kept === "queued") {
          toast.success(RUNSEQ_QUEUED_MESSAGE, { id: "runseq-offline-queued" });
          bcast();
        } else sayUnsaved();
      } finally {
        release();
      }
      if (kept === "queued") return "queued";
      void refetchRef.current(); // the cut write may have landed: the re-read says
      return "failed";
    }
    const results = answer;
    const failedResult = results.find((r) => r.error);
    const err = failedResult?.error;
    // The HTTP status of the SAME response the error came from — a 5xx/429 here is the
    // difference between "queue this press" and "throw this press away". Read it off the
    // response rather than off the error's prose (round 10; see isQueueableWriteError).
    const errStatus = failedResult?.status ?? null;
    const losers = updates.filter(
      (_, i) => !results[i].error && (results[i].data?.length ?? 0) === 0
    );
    // What landed is on the server, whatever became of the rest of this press.
    const landed = updates.filter(
      (_, i) => !results[i].error && (results[i].data?.length ?? 0) > 0
    );
    if (landed.length > 0) {
      serverHolds(
        serverRowsRef.current.map((r) => {
          const u = landed.find((x) => x.id === r.id);
          return u ? { ...r, ...u.partial } : r;
        }),
        "write"
      );
    }
    if (err) {
      // No network is not a failure on this screen — the festival is running and
      // the caller's press is the record of it. Queue it, KEEP the optimistic
      // board, and let the outbox replay it (lib/run-order-outbox.ts). Refetching
      // here instead would have wiped the operator's own press off the board, in
      // front of them, at a venue where they can do nothing about it.
      //
      // Only the writes that actually failed: "จบ + ต่อไป" sends two independent
      // requests, and when the network dies between them one has already landed.
      // Queueing that one too would replay it against a precondition it consumed
      // itself, and park the operator's own successful press as a conflict.
      const failed = updates.filter((_, i) => results[i].error);
      const kept = await queueOffline(failed, err.message, false, errStatus);
      if (kept === "queued") {
        toast.success(RUNSEQ_QUEUED_MESSAGE, { id: "runseq-offline-queued" });
        bcast();
        return "queued";
      }
      if (kept === "unsaved") sayUnsaved();
      else toast.error("บันทึกไม่สำเร็จ", { description: err.message });
      /* Pull the board back to server truth so the optimistic rows don't linger — but
         SAY SO ONLY IF IT WORKED. During the same outage that caused the failure this
         refetch is a no-op (it bails on a failed read), so the toast above used to
         promise a correction that never happened and the operator was left looking at
         an advanced row that no other device agreed with. Now the screen admits it. */
      const pulledBack = await refetchRef.current();
      if (pulledBack === "failed") {
        toast.warning("บอร์ดบนเครื่องนี้อาจไม่ตรงกับเครื่องอื่น", {
          id: "runseq-refetch-failed",
          description: "ดึงข้อมูลล่าสุดไม่สำเร็จ — กดรีเฟรชอีกครั้งเมื่อเน็ตกลับมา",
        });
      }
    } else if (losers.length > 0) {
      const denied = await writeWasDenied(losers);
      if (denied) {
        toast.error("ไม่มีสิทธิ์คุมคิว — ให้แอดมินตรวจสิทธิ์อีกครั้ง");
      } else {
        toast.info("ลำดับถูกเปลี่ยนจากเครื่อง/หน้าอื่นก่อน — อัปเดตบอร์ดให้ตรงแล้ว");
      }
      refetchRef.current();
    } else if (missedRefetchRef.current) {
      // a broadcast landed while we were writing — pull it now that we're settled
      refetchRef.current();
    }
    bcast();
    return !err && losers.length === 0 ? "committed" : "failed";
  }

  // A 0-row update means one of two very different things: another controller got
  // there first (the row moved on), or the write was DENIED — run_sequence's UPDATE
  // policy is `can_approve(tenant_id)`, so a demoted account still showing the
  // control bar (e.g. the desktop caller deriving canControl from its cached perms)
  // has every press silently filtered out, no error. SELECT is allowed for any
  // tenant member, so re-read the rows: if they still hold exactly what we expected,
  // nobody raced us — we simply weren't allowed to write.
  async function writeWasDenied(losers: CallerUpdate[]): Promise<boolean> {
    const { data, error } = await supabase
      .from("run_sequence")
      .select("*")
      .in(
        "id",
        losers.map((u) => u.id)
      );
    if (error || !data || data.length !== losers.length) return false;
    const rowsById = new Map((data as RunSeqLive[]).map((r) => [r.id, r]));
    return losers.every((u) => {
      const row = rowsById.get(u.id) as unknown as Record<string, unknown> | undefined;
      if (!row) return false;
      return Object.entries(u.expect ?? {}).every(([k, v]) => row[k] === v);
    });
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
          // the plan this drift was read against - a queued start moves with a re-plan
          planBasis: p != null ? firstPending.planned_start : null,
          // queued (no network, or the answer was lost), the label is told when it lands
          ...(firstStart ? { announceLive: eventId } : {}),
        },
      ]);
      // Fire-and-forget AFTER the write lands so the route's anti-spoof (it re-checks
      // run_sequence has a live row) passes — which is also why a merely QUEUED
      // start must not notify: the server has no live row yet, so the route would
      // refuse it anyway, and the label would be told a show started that the
      // server cannot see. A queued first start carries announceLive instead: the outbox
      // tells the label once its replay has landed (lib/run-order-outbox.ts).
      // The server sends it only on the show's real date and time (a dry run outside it
      // tells nobody) - say so to whoever pressed, so a held-back push is never a surprise.
      if (ok === "committed" && firstStart)
        notify("run_order_live", { eventId }, (answer) => {
          if (answer.skipped === "not_show_time") toast.info(NOT_SHOW_TIME_MESSAGE, { duration: 8000 });
        });
    } finally {
      inFlightRef.current = false;
    }
  }

  // End the live row (logs its actual_end + its start-offset as late/early) and start
  // the next pending one at the same instant, recomputing drift from the real clock.
  function next() {
    advance(true);
  }

  // "จบ" alone (2026-10-27, hunt 8): end the live act and start NOTHING - for a planned gap.
  // Every real run order has them (12:50 → 14:00, 16:20 → 16:40, 18:15 → 19:00), and with
  // "จบ + ต่อไป" as the only key the caller had two wrong choices: press at 12:50 and put
  // the 14:00 act on stage 70 min early (drift "เร็ว 70 น." on every device, the band's own
  // page "กำลังเล่น"), or wait and leave the act that left the stage live and "เกิน" for
  // 70 min, logged as an overrun. The next act then goes on with "เริ่มลำดับถัดไป" (start()),
  // its drift read from the real clock. The same write as next()'s first one, same path.
  function endOnly() {
    advance(false);
  }

  function advance(startNext: boolean) {
    if (!liveRow) {
      if (startNext) start();
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
    if (startNext && nextPending) {
      const p = parseClockToSeconds(nextPending.planned_start);
      const d =
        p != null
          ? normMin(Math.round((secOfDay(t) - p) / 60))
          : (liveRow.offset_min ?? drift);
      updates.push({
        id: nextPending.id,
        partial: { status: "live", actual_start: t.toISOString(), offset_min: d },
        expect: { status: "pending" },
        planBasis: p != null ? nextPending.planned_start : null, // see start()
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

  // What ดึง buffer has CONSUMED on this device: row id → the buffer_seconds it held
  // BEFORE we drained it. run_sequence has nowhere to record this server-side and the
  // app has no undo, so the ledger lives in localStorage (keyed to this festival, so
  // it survives a mid-show reload) and รีเซ็ต hands the slack back — otherwise a dry
  // run before doors permanently eats the real show's planned buffer.
  //
  // ⚠️ AND WHAT THE DRAIN LEFT THERE (2026-10-27): each entry is { before, after }, after
  // = the buffer_seconds the drain wrote. With `before` alone, รีเซ็ต handed it back to any
  // row whose buffer differed from it - so a buffer a staffer RE-PLANNED in the builder
  // after the drain (300 drained to 0, then set to 600) was written back to 300 and the
  // plan edit was lost. A row is restored only while it still holds `after`, and the
  // write is conditional on it. A bare number is a ledger stored before this (localStorage
  // outlives a deploy) and knows no `after`: it keeps the old rule.
  type BufferLedgerEntry = number | { before: number; after: number };
  const bufferLedgerKey = `cueiq-runorder-buffer:${tenantId}:${eventDate ?? "x"}:${eventName}`;
  function readBufferLedger(): Record<string, BufferLedgerEntry> {
    try {
      const parsed = JSON.parse(localStorage.getItem(bufferLedgerKey) || "null");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  /** An entry's pre-drain buffer, either format; null for anything unreadable. */
  function ledgerBefore(e: BufferLedgerEntry | undefined): number | null {
    if (typeof e === "number") return e;
    return e && typeof e === "object" && typeof e.before === "number" ? e.before : null;
  }
  /** What รีเซ็ต writes back into this row's buffer and the value the row must still hold
   *  for it (`guard`, null for an old bare-number entry) - or null to leave the row be. */
  function bufferRestore(
    r: RunSeqLive,
    ledger: Record<string, BufferLedgerEntry>
  ): { to: number; guard: number | null } | null {
    const e = ledger[r.id];
    if (typeof e === "number") return e !== r.buffer_seconds ? { to: e, guard: null } : null;
    if (!e || typeof e !== "object" || typeof e.before !== "number" || typeof e.after !== "number")
      return null;
    // re-planned since the drain (or never drained at all): the builder's value stands
    if (r.buffer_seconds !== e.after || e.before === e.after) return null;
    return { to: e.before, guard: e.after };
  }
  function writeBufferLedger(next: Record<string, BufferLedgerEntry> | null) {
    try {
      if (next && Object.keys(next).length > 0)
        localStorage.setItem(bufferLedgerKey, JSON.stringify(next));
      else localStorage.removeItem(bufferLedgerKey);
    } catch {
      // private mode / quota — the ledger is best-effort, never block the show
    }
  }

  // Absorb being late by compressing the slack still ahead (pending buffers). The
  // absorbed slack is CONSUMED — buffer_seconds is decremented on the pending rows
  // it came from — so pressing again later can only spend what actually remains.
  async function takeBuffer() {
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
    // The drift write goes FIRST and ALONE: these are independent row writes with no
    // transaction and no rollback, so if the live row's CAS loses the race (another
    // controller nudged ± a moment ago) the buffers must NOT be drained — that would
    // burn the plan's slack for nothing while the drift stays where it was.
    const shifted = await apply([
      {
        id: liveRow.id,
        partial: { offset_min: cur - absorb },
        expect: { status: "live", offset_min: liveRow.offset_min },
      },
    ]);
    if (shifted === "failed") return; // apply() already reported it + pulled the board back
    // drain the absorbed minutes from the pending rows' buffers, front to back
    const drains: CallerUpdate[] = [];
    const ledger = readBufferLedger();
    const ledgerBeforeDrain = { ...ledger }; // the entries this drain replaces (see the failed branch)
    let remain = absorb * 60;
    for (const r of pending) {
      if (remain <= 0) break;
      const take = Math.min(r.buffer_seconds || 0, remain);
      if (take <= 0) continue;
      drains.push({
        id: r.id,
        partial: { buffer_seconds: r.buffer_seconds - take },
        expect: { status: "pending", buffer_seconds: r.buffer_seconds },
      });
      // remember the ORIGINAL (first drain wins) so รีเซ็ต can hand it back - and what
      // this drain leaves, so it hands it back only over that (the ledger note above).
      // A row that no longer holds what our last drain left was re-planned since: the
      // slack this drain takes is the new plan's, so that is the one to hand back.
      const prev = ledger[r.id];
      const replanned = typeof prev === "object" && prev?.after !== r.buffer_seconds;
      ledger[r.id] = {
        before: (replanned ? null : ledgerBefore(prev)) ?? r.buffer_seconds,
        after: r.buffer_seconds - take,
      };
      remain -= take;
    }
    if (drains.length > 0) {
      writeBufferLedger(ledger); // record before writing: a half-landed drain is still restorable
      // The drift and the drains are one plan change and must land together. If
      // the drift only QUEUED, the pending rows carry no queued op of their own,
      // so a plain apply() would write them STRAIGHT to the server: the slack
      // would be spent while the lateness it was spent on stayed on the board,
      // and every other device would read a day that is later than it looks.
      // Queue them alongside so the whole change replays as one - as one PRESS, so a
      // drift that parks takes its drains with it instead of letting them land alone.
      if (shifted === "queued") {
        const kept = await queueOffline(drains, null, true, null, lastQueuedPressRef.current ?? undefined);
        if (kept !== "queued") {
          // kept nowhere: none of these rows will ever hold what the ledger says it left
          sayUnsaved();
          writeBufferLedger(ledgerBeforeDrain);
          return;
        }
        setRows((prev) =>
          prev.map((r) => {
            const d = drains.find((x) => x.id === r.id);
            return d ? { ...r, ...d.partial } : r;
          })
        );
      } else if ((await apply(drains)) === "failed") {
        // A drain that did not land must not stay in the ledger (2026-10-27, ตาที่ 3): its
        // `after` names a buffer the row never got, so รีเซ็ต read the row as re-planned
        // and handed nothing back, and the next ดึง buffer replaced the original `before`
        // with the drained value - the dry run's slack gone for good. Rows that DID land
        // (apply laid them into serverRowsRef) keep the new entry.
        const settled = { ...ledger };
        for (const d of drains) {
          const e = settled[d.id];
          const holds = serverRowsRef.current.find((r) => r.id === d.id)?.buffer_seconds;
          if (typeof e !== "object" || holds === e.after) continue;
          if (ledgerBeforeDrain[d.id] === undefined) delete settled[d.id];
          else settled[d.id] = ledgerBeforeDrain[d.id];
        }
        writeBufferLedger(settled);
        return;
      }
    }
    toast.success(`ดึง buffer ${absorb} นาที — ร่นคิวให้ทันขึ้น`);
  }

  async function resetAll() {
    // put back whatever ดึง buffer consumed on this device, alongside the live state
    const ledger = readBufferLedger();
    // only rows that still hold what the drain left (the ledger note above takeBuffer)
    const restoreOf = new Map(ordered.map((r) => [r.id, bufferRestore(r, ledger)]));
    const restores = ordered.filter((r) => restoreOf.get(r.id));
    const ok = await confirm({
      title: "รีเซ็ตการคุมคิว?",
      description: restores.length
        ? "ล้างเวลาจริง/สถานะทั้งหมด กลับไปเริ่มใหม่ตั้งแต่ต้น · คืน buffer ที่ดึงไปจากเครื่องนี้ด้วย"
        : "ล้างเวลาจริง/สถานะทั้งหมด กลับไปเริ่มใหม่ตั้งแต่ต้น",
      confirmText: "รีเซ็ต",
    });
    if (!ok) return;
    const done = await apply(
      ordered.map((r) => {
        const back = restoreOf.get(r.id);
        return {
          id: r.id,
          partial: {
            status: "pending",
            actual_start: null,
            actual_end: null,
            offset_min: null,
            ...(back ? { buffer_seconds: back.to } : {}),
          },
          // Reset is the one press that clears the whole board, so it is the one
          // that must never replay blind. Queued with no precondition it becomes
          // "make every row pending, whatever is there now" — and a dry run done
          // backstage on dead wifi would, hours later, erase the real show another
          // device had already driven half way through. With the rows we saw as
          // the precondition, a board that moved on parks for a human instead.
          // A restored buffer is guarded the same way: written back only over what
          // the drain left, never over a plan the builder changed meanwhile (2026-10-27).
          expect: {
            status: r.status,
            offset_min: r.offset_min,
            ...(back?.guard != null ? { buffer_seconds: back.guard } : {}),
          },
        };
      })
    );
    // ONLY once the restore is really on the server. The queued reset now carries
    // a precondition, so it can PARK — and if the ledger were already gone there
    // would be nothing left to hand those minutes back with: buffer_seconds keeps
    // no history server-side and the app has no undo.
    if (done === "committed") writeBufferLedger(null);
  }

  // Save the run-time report (planned vs actual, late/early, over/under per slot) as
  // a JPG to share with the crew after the show. Captures the off-screen report DOM.
  async function exportReport() {
    const el = reportRef.current;
    if (!el) return;
    setReportBusy(true);
    try {
      const safe = safeFileStem(eventName, "run-order");
      const how = await captureElementToImage(el, {
        filename: `${safe}_report.jpg`,
        shareTitle: `${eventName} — รายงานเวลา`,
        width: 720,
      });
      if (how === "cancelled") return; // user dismissed the share sheet — nothing was saved
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
  // A slot that ENDS after midnight (23:40 → 00:10 — the headliner's closing set,
  // every time) has planned_end EARLIER than planned_start as a clock-of-day, so a
  // plain subtraction is negative and Math.max(0, …) flattened it to a planned
  // length of ZERO. The NOW card then showed red "เกิน" counting up from the first
  // second of that band's set, and every downstream projection worked from a slot
  // the board believed took no time at all. Fold it forward a day instead, exactly
  // like the drift math above does.
  const livePlannedDur = (() => {
    if (!liveRow) return null;
    const s = parseClockToSeconds(liveRow.planned_start);
    const e = parseClockToSeconds(liveRow.planned_end);
    if (s == null || e == null) return null;
    const raw = e - s;
    return raw >= 0 ? raw : raw + 86400;
  })();
  const liveRemaining =
    livePlannedDur != null ? livePlannedDur - liveElapsed : null;

  const nextProjSec = nextPending ? projectedStartSec(nextPending) : null;
  // Folded like the drift math — a past-midnight slot (00:30 seen at 23:50) must
  // count down 40 min, not read "ถึงคิวแล้ว" a day early.
  const nextCountdown =
    nextProjSec != null ? normSec(nextProjSec - secOfDay(nowDate)) : null;

  // A planned gap after the live act: the next act is planned to start later than this one
  // is planned to end (folded, so a 23:50 end and a 00:10 start are a gap). Only then is
  // the end-only "จบ" key offered beside "จบ + ต่อไป" - see endOnly().
  const liveEndSec = liveRow ? parseClockToSeconds(liveRow.planned_end) : null;
  const nextStartSec = nextPending ? parseClockToSeconds(nextPending.planned_start) : null;
  const plannedGap =
    liveEndSec != null && nextStartSec != null && normSec(nextStartSec - liveEndSec) > 0;
  // Between acts (one ended with "จบ", or an act still waits ABOVE the one that ended):
  // the show is not over while any row is still pending (2026-10-27, hunt 8).
  const betweenActs = started && !liveRow && firstPending != null;
  const firstPendingProjSec = firstPending ? projectedStartSec(firstPending) : null;

  const driftTone =
    drift === 0 ? "ok" : drift > 0 ? "late" : "early";

  // presentation only (§G.11) — every now-based value stays behind `mounted`
  const actOver = mounted && liveRemaining != null && liveRemaining < 0;
  const actPct =
    mounted && livePlannedDur ? Math.min(100, (liveElapsed / livePlannedDur) * 100) : 0;
  const liveIdx = livePos + 1;

  return (
    // No transform / filter / backdrop-filter / container-type on this root or on the
    // content wrapper: any of them makes the off-screen report's `fixed` relative to
    // that box instead of the viewport, and the capture would shoot it in place.
    <div className="live-root">
      {/* The page light (v3 Stage Wash): this immersive route has no app frame, so it
          hangs its own, first in the root (not isolated — it paints in the immersive
          <main>'s stacking context, under everything), aimed at the NOW column: the
          left one from md: up (≈ 29–33 % of the window from a 768 px tablet to a
          1280 px laptop). Never inside the report below — that node is captured. */}
      <StageLight className="md:[--spot-x:31%]" />
      {/* The immersive top bar (this route has no app header): the way back, ON AIR,
          the show, and the stage clock. Sticky, not fixed, so the offline strip it
          hosts pushes the board down instead of sliding under the bar. */}
      <header className="live-top glass glass-top sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <h1 className="sr-only">
          คุมคิวงาน (Live) — {eventName}
        </h1>
        <div className="flex h-[54px] items-center gap-1 pl-1 pr-3 stage:h-16 stage:gap-3 stage:px-5">
          {backHref && (
            <Link
              href={backHref}
              aria-label={`กลับไป ${backLabel ?? ""}`.trim()}
              title={backLabel}
              className="flex h-11 min-w-[44px] flex-none items-center justify-center gap-1.5 rounded-[3px] text-foreground hover:bg-muted stage:px-2"
            >
              <ChevronLeft className="h-6 w-6" aria-hidden />
              {/* as given — it can be the event name, so never caps */}
              <span className="hidden max-w-[180px] truncate text-[15px] font-semibold stage:inline">
                {backLabel}
              </span>
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {/* The square blinks only while an act is live. Inline, because
                  `.onair-tag i` out-ranks an animate-none utility. */}
              <span className="onair-tag">
                <i aria-hidden style={liveRow ? undefined : { animation: "none" }} />
                On Air
              </span>
              <span className="eyebrow truncate text-[11.5px] text-muted-foreground">
                Run Order
              </span>
            </div>
            <p className="mt-[3px] truncate text-[14px] font-semibold leading-tight stage:font-display stage:text-[21px] stage:font-extrabold">
              {eventName}
              {eventDate ? ` · ${eventDate}` : ""}
            </p>
          </div>
          <div className="flex-none text-right">
            <div className="num text-[25px] leading-none stage:text-[28px]">
              {mounted ? wall : "··:··:··"}
            </div>
            <div className="mt-[2px] text-[10.5px] text-faint">เวลาจริง</div>
          </div>
          <CallerMenuButton />
        </div>
        {/* hosted here, the root layout's in-flow copy stands down */}
        <OfflineBanner placement="header" />
      </header>

      {/* The content owns its gutter (the immersive <main> has none), and clears the
          fixed dock by 20+ px when scrolled to the end. */}
      <div
        className={cn(
          "mx-auto w-full max-w-5xl space-y-3 px-4 pt-3 stage:px-5 stage:pt-4 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:space-y-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:pt-2",
          canControl
            ? "pb-[calc(112px+env(safe-area-inset-bottom))] stage:pb-[calc(124px+env(safe-area-inset-bottom))]"
            : "pb-6"
        )}
      >
        {notice}

        {/* Unsent presses. A board holding moves nobody else has seen looks exactly
            like one that is in sync, and at a festival that gap is the difference
            between "we are on time" and "nobody downstream knows we ran late". */}
        {waitingHere.length > 0 && (
          <div className="flex items-start gap-2 rounded-[2px] bg-warning/[.12] px-3 py-2 text-[13px] shadow-[inset_3px_0_0_hsl(var(--warning))]">
            <CloudOff className="mt-0.5 h-4 w-4 flex-none text-warning-ink" aria-hidden />
            <p>
              <span className="font-semibold text-warning-ink">
                ค้างซิงค์ {waitingHere.length} รายการ
              </span>{" "}
              <span className="text-muted-foreground">
                — คิวบนเครื่องนี้เดินต่อตามที่กดไว้ เครื่องอื่นจะยังไม่เห็นจนกว่าเน็ตจะกลับมา
              </span>
            </p>
          </div>
        )}

        {/* Another account's unsent presses (foreignRunSeqRows): not on the board above and
            not sent from here - they go up when that account signs in on this device. */}
        {foreignHere.length > 0 && (
          <p className="px-1 text-[12.5px] text-muted-foreground" data-testid="runseq-foreign-queued">
            มีคิวของบัญชีอื่น {foreignHere.length} รายการรอในเครื่องนี้ — ส่งขึ้นเมื่อบัญชีนั้นเข้าสู่ระบบ
          </p>
        )}

        {/* Parked: someone else drove the board while this device was offline. We do
            not overwrite them and we do not throw this away — a human decides. */}
        {parked.length > 0 && (
          <div className="space-y-2 rounded-[2px] bg-destructive/[.12] px-3 py-2 text-[13px] shadow-[inset_3px_0_0_hsl(var(--destructive))]">
            <p className="flex items-start gap-1.5 font-semibold text-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 flex-none text-destructive" aria-hidden />
              คิวถูกเปลี่ยนจากเครื่องอื่นระหว่างที่เครื่องนี้ออฟไลน์ ({parked.length})
            </p>
            <p className="text-muted-foreground">
              สิ่งที่กดไว้บนเครื่องนี้ยังไม่ถูกบันทึก เพราะจะไปทับของคนอื่น —
              ดูบอร์ดด้านล่างว่าตรงกับหน้างานไหม ถ้าตรงแล้วกดทิ้งได้
            </p>
            <ul className="space-y-1">
              {parked.map((o) => (
                <li key={o.rowId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{o.label}</span>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "ทิ้งสิ่งที่กดไว้ตอนออฟไลน์?",
                        description: `“${o.label}” จะถูกทิ้ง และใช้คิวที่อยู่บนเซิร์ฟเวอร์แทน`,
                        confirmText: "ทิ้ง",
                      });
                      if (ok) await discardRunSeqOp(o.rowId);
                    }}
                  >
                    ทิ้งอันนี้
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!canControl && (
          <p className="flex items-center gap-2 rounded-[2px] bg-info/[.12] px-3 py-2 text-[13px] text-info-ink">
            <Eye className="h-4 w-4 flex-none" aria-hidden />
            กำลังดูแบบอ่านอย่างเดียว — เฉพาะสตาฟ (แอดมิน/ทีมค่าย) คุมคิวได้
          </p>
        )}

        {/* Overall drift (icon + word, never colour alone) + the report export */}
        <div className="flex min-h-[44px] items-center gap-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:min-h-0">
          <span
            className={cn(
              "chip chip-lg",
              !started
                ? "chip-neutral"
                : driftTone === "ok"
                  ? "chip-success"
                  : driftTone === "late"
                    ? "chip-warning"
                    : "chip-info"
            )}
          >
            {!started ? (
              <CircleDashed aria-hidden />
            ) : driftTone === "ok" ? (
              <CheckCircle2 aria-hidden />
            ) : driftTone === "late" ? (
              <Hourglass aria-hidden />
            ) : (
              <FastForward aria-hidden />
            )}
            {started ? driftPhrase(drift) : "ยังไม่เริ่มงาน"}
          </span>
          {mounted && doneRows.length > 0 && (
            <Button
              variant="secondary"
              className="ml-auto"
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
        </div>

        {/* NOW, NEXT, the tools and the full board. Two column wrappers, because one
            shared grid row ties NEXT's height to NOW's: at stage (landscape iPad /
            laptop) a ~370 px NOW beside a ~120 px NEXT left a hole under NEXT and
            pushed the Running Order — and the LIVE row — under the dock until you
            scrolled, on the device that drives the festival. So:
            • stage: the wrappers are flex columns — NOW over the tools on the left,
              NEXT over the Running Order on the right — each as tall as its content.
            • below stage: the wrappers are `display: contents`, so their children are
              this grid's items, and `order` keeps the reading order NOW → NEXT →
              tools → board (≥ md: NOW | NEXT side by side, the rest full width).
            NEXT holds nothing focusable, so tab order matches what is seen. */}
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="contents stage:flex stage:min-w-0 stage:flex-col stage:gap-3">
            {/* NOW — the screen's ONE lit hero. No px-*: `.now` owns its padding.
                Keyed and lit in the act's OWN band (§G.11): --lit for the edge, and
                --lit-g its capped stage light (lib/band-triplet.ts). Unknown colour →
                no inline style, so the device's band light, never a grey borrowed glow. */}
            <section
              className="now lit cut pb-3.5 [--cut:18px] stage:[--cut:26px] stage:[--pad:24px]"
              style={liveColor ? (bandLitVars(liveColor) as CSSProperties) : undefined}
            >
              <div className="zhead stage:h-[46px] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:h-8">
                <span className="ztag">Now</span>
                {liveRow && (
                  <span className="num zidx text-[16px]">
                    {String(liveIdx).padStart(2, "0")} / {ordered.length}
                  </span>
                )}
                {liveRow?.planned_start && (
                  <span className="zend">
                    แผน
                    <b>
                      {formatClockOfDay(parseClockToSeconds(liveRow.planned_start)!)}
                      {liveRow.planned_end
                        ? `–${formatClockOfDay(parseClockToSeconds(liveRow.planned_end)!)}`
                        : ""}
                    </b>
                  </span>
                )}
              </div>
              {liveRow ? (
                <>
                  <div className="mt-1.5 flex items-center gap-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:mt-1">
                    {/* the act's name as typed — display face, never caps. py + -my:
                        room inside the clip for Kanit's tone marks and ุ / ู
                        (components/live/now-card.tsx), at the same row height */}
                    <h2 className="disp min-w-0 flex-1 truncate py-[.25em] -my-[.25em] text-[26px] leading-[1.04] stage:text-[40px]">
                      {liveRow.title || "(ไม่มีชื่อ)"}
                    </h2>
                    <RunKindChip kind={liveRow.kind} />
                  </div>
                  <p className="mt-0.5 flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] text-muted-foreground [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:hidden">
                    เริ่มจริง{" "}
                    <span className="num text-[15px] text-foreground">
                      {mounted && liveRow.actual_start
                        ? formatClockOfDay(secOfDay(new Date(liveRow.actual_start)))
                        : "—"}
                    </span>
                    {mounted && startLateMin(liveRow) != null && (
                      <span className={cn("font-semibold", toneInk(startLateMin(liveRow)!))}>
                        ({driftPhrase(startLateMin(liveRow)!)})
                      </span>
                    )}
                  </p>
                  {/* Elapsed, on the Live countdown face: fixed height, fitted to the
                      column, never italic. */}
                  {/* Landscape phone (390 px tall, the dock fixed over the bottom 88): the
                      164 px clock's box alone is 131 px, so it is the same 120 px cap in
                      a 96 px box the NOW card uses there (components/live/now-card.tsx),
                      and the strip, the "เริ่มจริง" line, the title row's top margin and
                      the page's top padding / row gap above give their pixels back — on a
                      667 × 375 iPhone SE the clock then clears the dock by ~10 px
                      (without those it only touched it). */}
                  <div className="mt-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:mt-1 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:[&_.cd-wrap]:!h-[96px] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:[&_.cd]:![--cd-max:120px]">
                    <Countdown seconds={mounted ? Math.floor(liveElapsed) : 0} max={164} />
                  </div>
                  {/* The act's planned slot: a meter inside it, hazard hatch past it. */}
                  {actOver ? (
                    <div className="hatch mt-3 h-2" aria-hidden />
                  ) : (
                    <div className="track mt-3" aria-hidden>
                      <span style={{ width: `${actPct}%` }} />
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
                    <span>ผ่านไป</span>
                    {mounted && liveRemaining != null ? (
                      actOver ? (
                        // past the planned end: the band-independent alarm, "+", octagon
                        <span className="chip chip-alarm">
                          <OctagonAlert aria-hidden />
                          เกิน{" "}
                          <span className="num">{formatOvertime(Math.round(liveRemaining))}</span>
                        </span>
                      ) : (
                        <span>
                          เหลือ{" "}
                          <span className="num text-[14px] text-foreground">
                            {formatCountdown(Math.round(liveRemaining))}
                          </span>
                        </span>
                      )
                    ) : (
                      <span />
                    )}
                    <span>
                      แผน{" "}
                      <span className="num text-[14px] text-foreground">
                        {livePlannedDur != null ? formatDuration(livePlannedDur) : "—"}
                      </span>
                    </span>
                  </div>
                  {liveRow.linked_event_id && (
                    <Link
                      href={`/events/${liveRow.linked_event_id}/live`}
                      className="mt-2 inline-flex h-11 items-center gap-1.5 text-[14px] font-semibold text-primary-ink hover:underline"
                    >
                      <ListMusic className="h-4 w-4" aria-hidden /> เปิด setlist วงนี้
                    </Link>
                  )}
                </>
              ) : (
                <p className="flex items-center justify-center gap-2 py-10 text-[15px] text-muted-foreground">
                  {betweenActs ? (
                    <span data-cueiq-between>
                      ถัดไป: {firstPending!.title || "(ไม่มีชื่อ)"}
                      {firstPendingProjSec != null && (
                        <>
                          {" · คาดเริ่ม "}
                          <b className="num text-[17px] text-foreground">
                            {formatClockOfDay(firstPendingProjSec)}
                          </b>
                        </>
                      )}
                    </span>
                  ) : started ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-success-ink" aria-hidden />
                      จบงานแล้ว
                    </>
                  ) : (
                    "ยังไม่เริ่ม — กด “เริ่มงาน”"
                  )}
                </p>
              )}
            </section>

            {/* Tools (approvers only). START / จบ + ต่อไป and ±1 live in the dock; ±5 sit
                here on a phone and move into the dock at stage width. The read-only
                notice for everyone else is the banner at the top. order-1: after
                NEXT below stage, under NOW at stage. */}
            {canControl && (
              <section className="slab order-1 space-y-2 p-3 md:col-span-2">
                <div className="grid grid-cols-2 gap-[3px]">
                  <Button
                    variant="secondary"
                    className="rounded-[2px] stage:hidden"
                    disabled={!liveRow || busy}
                    onClick={() => adjust(-5)}
                  >
                    <span className="num text-[17px] leading-none">−5</span> นาที
                  </Button>
                  <Button
                    variant="secondary"
                    className="rounded-[2px] stage:hidden"
                    disabled={!liveRow || busy}
                    onClick={() => adjust(5)}
                  >
                    <span className="num text-[17px] leading-none">+5</span> นาที
                  </Button>
                  <Button
                    variant="secondary"
                    className="rounded-[2px]"
                    disabled={!liveRow || busy}
                    onClick={takeBuffer}
                  >
                    <Hand className="h-4 w-4" /> ดึง buffer
                  </Button>
                  <Button
                    variant="destructive-outline"
                    className="rounded-[2px]"
                    disabled={!started || busy}
                    onClick={resetAll}
                  >
                    <RotateCcw className="h-4 w-4" /> รีเซ็ต
                  </Button>
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  “จบ + ต่อไป” = ปิดลำดับนี้ (บันทึกเวลาจริง) แล้วเริ่มลำดับถัดไปทันที ·{" "}
                  {liveRow && plannedGap && "“จบ” = ปิดลำดับนี้อย่างเดียว ถ้ามีช่วงพักก่อนลำดับถัดไป · "}±นาที =
                  เลื่อนคิวข้างหน้า · ดึง buffer = ร่นเวลาให้ทันเมื่อช้า
                </p>
              </section>
            )}
          </div>

          <div className="contents stage:flex stage:min-w-0 stage:flex-col stage:gap-3">
            {/* NEXT */}
            <section className="slab px-4 pb-3 pt-2">
              <div className="flex h-7 items-center gap-2">
                <p className="nlabel">Next</p>
                {nextPending && <RunKindChip kind={nextPending.kind} />}
              </div>
              {nextPending ? (
                <div className="mt-1 space-y-1">
                  <h2 className="disp truncate text-[22px] leading-tight stage:text-[30px]">
                    {nextPending.title || "(ไม่มีชื่อ)"}
                  </h2>
                  <p className="text-[13px] text-muted-foreground">
                    คาดเริ่ม{" "}
                    <b className="num text-[17px] text-foreground">
                      {nextProjSec != null ? formatClockOfDay(nextProjSec) : "—"}
                    </b>
                    {/* Clock-of-day countdown is only meaningful once the show runs —
                        pre-show it would falsely read "ถึงคิวแล้ว" (same gate as
                        event-run-status.tsx). */}
                    {mounted &&
                      started &&
                      nextCountdown != null &&
                      (nextCountdown > 0 ? (
                        <>
                          {" "}
                          · อีก{" "}
                          <span className="num text-[15px] text-foreground">
                            {formatCountdown(Math.round(nextCountdown))}
                          </span>
                        </>
                      ) : (
                        <span className="font-semibold text-warning-ink"> · ถึงคิวแล้ว</span>
                      ))}
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-muted-foreground">— ไม่มีลำดับถัดไป —</p>
              )}
            </section>

            {/* Full board. order-2: last below stage, under NEXT at stage. */}
            <div className="order-2 space-y-3 md:col-span-2">
              <p className="nlabel pt-2 text-[19px]">Running Order</p>
              <div className="stack">
                {ordered.length === 0 ? (
                  <p className="rounded-[2px] border border-dashed py-10 text-center text-sm text-muted-foreground">
                    ยังไม่มีลำดับงาน — สร้างที่ Running Order ก่อน
                  </p>
                ) : (
                  ordered.map((r) => {
                    const meta = kindMeta(r.kind);
                    const KindIcon = meta.icon;
                    const proj = projectedStartSec(r);
                    const isLive = r.status === "live";
                    const isDone = r.status === "done";
                    return (
                      <div
                        key={r.id}
                        className={cn(
                          "slab relative flex min-h-[56px] items-center gap-3 py-2 pl-4 pr-3",
                          isLive && "bg-primary/[.14]",
                          isDone && "opacity-60"
                        )}
                      >
                        {/* the kind's rail: the act's OWN band colour for a band act
                            (the device's band when the board can't know it), neutral
                            otherwise */}
                        <i
                          aria-hidden
                          className={cn(
                            "absolute inset-y-0 left-0 w-1",
                            actColor(r) ? "bg-[hsl(var(--band))]" : meta.rail
                          )}
                          style={
                            actColor(r)
                              ? ({ "--band": bandTriplet(actColor(r)) } as CSSProperties)
                              : undefined
                          }
                        />

                        {/* time — numerals are never band-coloured */}
                        <div className="w-[4.5rem] shrink-0 text-center">
                          {isDone && r.actual_start && mounted ? (
                            <span className="num text-[15px] text-muted-foreground">
                              {formatClockOfDay(secOfDay(new Date(r.actual_start)))}
                            </span>
                          ) : proj != null ? (
                            <span className="num text-[15px]">{formatClockOfDay(proj)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          {r.planned_start && proj != null && drift !== 0 && !isDone && (
                            <span className="num block text-[11px] text-faint line-through">
                              {formatClockOfDay(parseClockToSeconds(r.planned_start)!)}
                            </span>
                          )}
                        </div>

                        {/* title + kind (icon + word, on a meta line so the row stays 56 px) */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-medium">
                            {isLive && (
                              <span aria-hidden className="onair-dot mr-1.5 inline-block align-[1px]" />
                            )}
                            {r.title || "(ไม่มีชื่อ)"}
                          </p>
                          <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-muted-foreground">
                            <KindIcon className="h-3 w-3 flex-none" aria-hidden />
                            {meta.label}
                          </span>
                        </div>

                        {/* status / log */}
                        <div className="shrink-0 text-right">
                          {isLive ? (
                            <span className="chip chip-primary en">
                              <Radio aria-hidden />
                              Live
                            </span>
                          ) : isDone ? (
                            (() => {
                              const log = mounted ? startLateMin(r) : null;
                              const dur = mounted ? durationDeltaMin(r) : null;
                              return (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-[12.5px] font-semibold",
                                      log == null ? "text-muted-foreground" : toneInk(log)
                                    )}
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                    {log == null ? "เสร็จ" : driftPhrase(log)}
                                  </span>
                                  {dur != null && dur !== 0 && (
                                    <span
                                      className={cn(
                                        "text-[11px] font-medium",
                                        dur > 0 ? "text-warning-ink" : "text-muted-foreground"
                                      )}
                                    >
                                      {durPhrase(dur)}
                                    </span>
                                  )}
                                </div>
                              );
                            })()
                          ) : r.id === nextPending?.id || r.buffer_seconds > 0 ? (
                            <div className="flex flex-col items-end gap-1">
                              {r.id === nextPending?.id && (
                                <span className="chip chip-solid en">Next</span>
                              )}
                              {r.buffer_seconds > 0 && (
                                <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                                  <Timer className="h-3.5 w-3.5" aria-hidden />
                                  buffer {Math.round(r.buffer_seconds / 60)}น.
                                </span>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
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
            <h2 className="poster text-[22px]">{eventName}</h2>
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
                    <td className="num py-1.5 pr-2 text-muted-foreground">
                      {planned}
                    </td>
                    <td className="num py-1.5 pr-2">{actual}</td>
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

      {/* The dock (approvers only): START / จบ + ต่อไป in the NEXT slot — the same two
          Buttons, handlers and disabled rules as before, re-dressed — flanked by the
          ±1 push keys, and ±5 too at stage width. Every Thai word on a dock key
          carries `.th`: the dock variant sets display caps. */}
      {canControl && (
        <div
          className="dock glass glass-bottom fixed inset-x-0 bottom-0 z-40 pb-[max(12px,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-3 stage:px-5"
          // A held Enter is one press: its repeats must not walk the board one act per landed write,
          // and "จบ + ต่อไป" has no undo short of รีเซ็ต (2026-10-30, hunt 12).
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.repeat) e.preventDefault();
          }}
        >
          <div className="mx-auto flex max-w-[880px] gap-2">
            <Button
              variant="dock"
              className="hidden stage:inline-flex"
              aria-label="เลื่อนคิว −5 นาที"
              disabled={!liveRow || busy}
              onClick={() => adjust(-5)}
            >
              <span className="num text-[22px] leading-none">−5</span>
              <span className="th text-[11px] font-medium">นาที</span>
            </Button>
            <Button
              variant="dock"
              aria-label="เลื่อนคิว −1 นาที"
              disabled={!liveRow || busy}
              onClick={() => adjust(-1)}
            >
              <span className="num text-[22px] leading-none">−1</span>
              <span className="th text-[11px] font-medium">นาที</span>
            </Button>
            {/* min-w-0: the subtitle truncates instead of pushing +1 off a 390 px screen */}
            {/* "จบ" alone - only before a planned gap (see endOnly()). A secondary dock key
                beside "จบ + ต่อไป", which stays exactly where it was. A held Enter on it
                clicks once: Chromium re-clicks a focused button on every auto-repeat. */}
            {liveRow && plannedGap && (
              <Button
                variant="dock"
                aria-label={`จบ ${liveRow.title || "(ไม่มีชื่อ)"} (ยังไม่เริ่มลำดับถัดไป)`}
                onClick={endOnly}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.repeat) e.preventDefault();
                }}
                disabled={busy}
              >
                <Flag aria-hidden className="h-5 w-5" />
                <span className="th text-[11px] font-medium">จบ</span>
              </Button>
            )}
            {liveRow ? (
              <Button variant="next" className="min-w-0 flex-1" onClick={next} disabled={busy}>
                <span className="min-w-0 text-left leading-none">
                  <span className="block font-display-x text-[32px] font-extrabold uppercase italic leading-[.82] tracking-[.03em] stage:text-[36px]">
                    {nextPending ? "Next" : "End"}
                  </span>
                  {/* py + margins that give it back (the 5 px gap included): at the
                      key's leading-none the clip cut Kanit's tone marks off "เริ่ม" */}
                  <span className="-mb-[.25em] mt-[calc(5px_-_.25em)] block max-w-[170px] truncate py-[.25em] text-[12.5px] font-medium opacity-90 stage:max-w-[420px]">
                    {nextPending
                      ? `จบ + ต่อไป · ${nextPending.title || "(ไม่มีชื่อ)"}`
                      : "จบงาน"}
                  </span>
                </span>
                {nextPending ? <SkipForward aria-hidden /> : <Flag aria-hidden />}
              </Button>
            ) : (
              <Button
                variant="next"
                className="min-w-0 flex-1"
                onClick={start}
                disabled={busy || !firstPending}
              >
                <span className="min-w-0 text-left leading-none">
                  <span className="block font-display-x text-[32px] font-extrabold uppercase italic leading-[.82] tracking-[.03em] stage:text-[36px]">
                    Start
                  </span>
                  <span className="-mb-[.25em] mt-[calc(5px_-_.25em)] block max-w-[170px] truncate py-[.25em] text-[12.5px] font-medium opacity-90 stage:max-w-[420px]">
                    {`${started ? "เริ่มลำดับถัดไป" : "เริ่มงาน"}${
                      firstPending ? ` · ${firstPending.title || "(ไม่มีชื่อ)"}` : ""
                    }`}
                  </span>
                </span>
                <Play aria-hidden />
              </Button>
            )}
            <Button
              variant="dock"
              aria-label="เลื่อนคิว +1 นาที"
              disabled={!liveRow || busy}
              onClick={() => adjust(1)}
            >
              <span className="num text-[22px] leading-none">+1</span>
              <span className="th text-[11px] font-medium">นาที</span>
            </Button>
            <Button
              variant="dock"
              className="hidden stage:inline-flex"
              aria-label="เลื่อนคิว +5 นาที"
              disabled={!liveRow || busy}
              onClick={() => adjust(5)}
            >
              <span className="num text-[22px] leading-none">+5</span>
              <span className="th text-[11px] font-medium">นาที</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
