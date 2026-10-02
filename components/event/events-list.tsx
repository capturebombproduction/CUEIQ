"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import {
  CalendarDays,
  MapPin,
  Search,
  Radio,
  Timer,
  CheckCircle2,
  HardDriveDownload,
  Loader2,
  DownloadCloud,
  ChevronDown,
  Headphones,
  Disc3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";
import { TitleSlab } from "@/components/title-slab";
import { DuplicateEventButton } from "@/components/event/duplicate-event-button";
import { DeleteEventButton } from "@/components/event/delete-event-button";
import { DeviceStorage } from "@/components/event/device-storage";
import { DeadlineChip } from "@/components/event/deadline-chip";
import { dateParts } from "@/components/event/date-parts";
// The band colour as the triplet `.date-tile` reads; a missing or garbled colour
// (a cached row) falls back to muted ink instead of crashing the list.
import { bandTriplet } from "@/lib/band-triplet";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import {
  getReadiness,
  prefetchEventAudio,
  type Readiness,
  type PrefetchTarget,
} from "@/lib/audio-prefetch";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";
import { type EventRow, type GroupStatus } from "@/lib/types";
import {
  shortClock,
  formatDuration,
  bkkTodayKey,
  monthBeforeKey,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import { showTimesLabel } from "@/lib/next-show";

type EventWithGroup = EventRow & {
  groups: {
    name: string;
    color: string | null;
    exempt_from_deadline?: boolean;
  } | null;
};


// Pinned to Asia/Bangkok — this component is server-rendered (see
// app/(app)/dashboard/page.tsx), and Vercel runs UTC, so the runtime's local
// date would put yesterday's show under "Upcoming" for the first 7 hours of
// every Bangkok day.
function todayKey(): string {
  return bkkTodayKey();
}

function daysUntil(dateStr: string): number {
  // Diff the "YYYY-MM-DD" keys as UTC midnights (not device-local midnight)
  // so the result only depends on the calendar days involved, matching
  // todayKey()'s Bangkok-pinned key regardless of where this runs.
  const today = new Date(`${todayKey()}T00:00:00Z`);
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/** What the "upcoming" order reads off a show. */
type UpcomingKey = { event_date: string | null; show_start_time: string | null };

/** The order "Upcoming" is listed in: soonest date first, then by start time so
 *  same-day shows run in order. A show with no date sorts last. Exported so the one
 *  caller that has to agree with it (the desktop's call-time lookup, which must read
 *  the SAME show the ticket prints) uses this instead of a second copy of the sort. */
export function compareUpcoming(a: UpcomingKey, b: UpcomingKey): number {
  const d = (a.event_date ?? "9999").localeCompare(b.event_date ?? "9999");
  return d !== 0
    ? d
    : (a.show_start_time ?? "99:99:99").localeCompare(b.show_start_time ?? "99:99:99");
}

/** The show the Next Show ticket is about: the soonest DATED show that is not past.
 *  EventsList derives its own `nextShow` from the same filter and the same order
 *  (compareUpcoming), minus the search box — the ticket is hidden while one is typed. */
export function nextTicketShow<T extends UpcomingKey>(
  events: readonly T[],
  today: string = todayKey()
): T | undefined {
  return events
    .filter((e) => !!e.event_date && e.event_date >= today)
    .sort(compareUpcoming)[0];
}

/** Per-device offline readiness for one event: audio bytes + whether this event's
 *  management bundle (คิวโชว์ / ตาราง / ไมค์ / ไลน์อัพ) is cached on the device. */
type EventReadiness = {
  ready: number;
  total: number;
  /** desktop: the bundle is in the read-cache → the show can be OPENED with no net. */
  data: boolean;
};

function OfflineReadyBadge({ r }: { r: EventReadiness }) {
  // Nothing to play AND the data already on the device (also every non-desktop
  // caller, where `data` is always true) → stay silent, exactly as before. A day
  // with no audio at all — บูธ/ทอล์ก, or files not uploaded yet — must still say
  // when its ตาราง/ไมค์/ไลน์อัพ isn't on the device.
  if (r.total === 0 && r.data) return null;
  const bytesDone = r.ready >= r.total;
  // พร้อมออฟไลน์ = ข้อมูล + ไฟล์. A device holding every file but no cached bundle
  // opens tonight's show as "ไม่พบงานนี้" at the venue — the audio sitting on disk is
  // unreachable — so that state must NOT read green.
  const done = bytesDone && r.data;
  return (
    <span
      className={cn("chip", done ? "chip-success" : "chip-neutral")}
      title={
        done
          ? "ข้อมูลงานและไฟล์เพลงอยู่ในเครื่องนี้ครบแล้ว เปิดและเล่นได้แม้เน็ตหลุด"
          : bytesDone
            ? `${r.total > 0 ? "ไฟล์เพลงครบแล้ว แต่" : ""}ยังไม่ได้เก็บข้อมูลงาน (คิวโชว์/ตาราง/ไมค์) ลงเครื่อง — กด ‘เตรียมทุกงานที่จะถึง’ หรือเปิดงานนี้ตอนออนไลน์ 1 ครั้ง`
            : "เครื่องนี้ยังโหลดเพลงไม่ครบ — เปิดงานแล้วกด ‘เตรียมเครื่องนี้’"
      }
    >
      {done ? (
        <>
          <CheckCircle2 aria-hidden /> พร้อมออฟไลน์
        </>
      ) : bytesDone ? (
        <>
          <HardDriveDownload aria-hidden /> ยังไม่มีข้อมูลงาน
        </>
      ) : (
        <>
          <HardDriveDownload aria-hidden /> เพลง {r.ready}/{r.total}
        </>
      )}
    </span>
  );
}

/** Copy / delete in a card's bottom-right corner (editors only). On a touch screen
 *  they are always showing — there is no hover to reveal them — so the card leaves
 *  them their own strip; they once sat on top of its last line. */
function CornerActions({
  ev,
  onDeleted,
}: {
  ev: EventWithGroup;
  onDeleted?: (id: string) => void;
}) {
  return (
    <>
      <DuplicateEventButton eventId={ev.id} eventName={ev.name} showStartTime={ev.show_start_time} />
      <DeleteEventButton eventId={ev.id} eventName={ev.name} onDeleted={onDeleted} />
    </>
  );
}

/**
 * An upcoming show as a ticket stub (spec §G.1): the date on a solid tile of the
 * band's own colour (darkened 30 %, white type — it holds on any group colour), then
 * band + status, the name, the stage time and venue, and the deadline / offline
 * chips. Every field is optional-chained: the desktop renders cached rows that can
 * lack any of them (no event_type, no times, no colour).
 */
function EventStub({
  ev,
  onTicket = false,
  editable,
  readiness,
  onDeleted,
}: {
  ev: EventWithGroup;
  /** This show is the Next Show ticket right above, which already carries its
   *  deadline chip. Said twice, the chip's line made the first stub 123 px tall
   *  and pushed it under the tab bar on a phone (spec §J: ≤ 705). */
  onTicket?: boolean;
  editable: boolean;
  readiness?: EventReadiness;
  onDeleted?: (id: string) => void;
}) {
  const dp = dateParts(ev.event_date);
  const time = shortClock(ev.show_start_time);
  return (
    <Link
      href={`/events/${ev.id}`}
      className="stub slab group relative flex items-stretch overflow-hidden"
      style={{ "--band": bandTriplet(ev.groups?.color) } as CSSProperties}
    >
      {editable && <CornerActions ev={ev} onDeleted={onDeleted} />}
      <div className="date-tile py-2.5">
        <span className="eyebrow text-[11px]">{dp?.wd ?? "—"}</span>
        <span className="num mt-[3px] text-[36px] font-extrabold leading-[.92]">{dp?.day ?? "—"}</span>
        <span className="eyebrow mt-[3px] text-[11px]">{dp?.mon ?? ""}</span>
      </div>
      <div className={cn("min-w-0 flex-1 px-3.5 py-2.5", editable && "[@media(hover:none)]:pb-14")}>
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 truncate">{ev.groups?.name ?? "—"}</span>
          <StatusBadge status={ev.status as GroupStatus} className="ml-auto shrink-0" />
        </div>
        <h3
          title={ev.name}
          className="mt-[4px] truncate text-[15px] font-semibold leading-snug group-hover:text-primary-ink sm:whitespace-normal sm:line-clamp-2 sm:[overflow-wrap:anywhere]"
        >
          {ev.name}
        </h3>
        {(time || ev.venue) && (
          <div className="mt-[1px] flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {time && <span className="num text-[17px] text-foreground">{time}</span>}
            {time && ev.venue && <span className="text-faint">·</span>}
            {ev.venue && <span className="truncate">{ev.venue}</span>}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden">
          {!onTicket && <DeadlineChip deadline={ev.deadline} exempt={ev.groups?.exempt_from_deadline} />}
          {readiness && <OfflineReadyBadge r={readiness} />}
        </div>
        {ev.last_run_seconds != null && (
          <p className="mt-1 flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <Timer aria-hidden className="h-[13px] w-[13px]" /> โชว์ล่าสุดใช้เวลา{" "}
            <span className="num text-[13px] text-foreground">{formatDuration(ev.last_run_seconds)}</span>
          </p>
        )}
      </div>
    </Link>
  );
}

/** A past show as one compact row (spec §G.1): day over month, name and band ·
 *  venue, and the run time the show actually took when one was recorded. */
function PastRow({
  ev,
  editable,
  onDeleted,
}: {
  ev: EventWithGroup;
  editable: boolean;
  onDeleted?: (id: string) => void;
}) {
  const dp = dateParts(ev.event_date);
  return (
    <Link
      href={`/events/${ev.id}`}
      className={cn(
        "slab group relative flex min-h-[60px] items-center gap-3 px-3.5 py-3",
        editable && "[@media(hover:none)]:pr-[108px]"
      )}
    >
      {editable && <CornerActions ev={ev} onDeleted={onDeleted} />}
      <div className="w-[38px] flex-none text-center leading-none">
        <div className="num text-[24px]">{dp?.day ?? "—"}</div>
        <div className="eyebrow mt-[3px] text-[10px] text-faint">{dp?.mon ?? ""}</div>
      </div>
      <div className="min-w-0 flex-1">
        {/* Two lines, not one cut line: an editor on a touch screen gives 108 px of the
            row to the always-showing copy/delete buttons, and on a phone a single-line
            `truncate` left the name about ten characters. No `block` here — it would
            replace the clamp's display and stop it clamping (see overview-client.test.tsx). */}
        <h3 className="line-clamp-2 break-words text-[14px] font-medium group-hover:text-primary-ink">{ev.name}</h3>
        {(ev.groups?.name || ev.venue) && (
          <p className="truncate text-[12px] text-faint">
            {[ev.groups?.name, ev.venue].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      {ev.last_run_seconds != null && (
        <div
          className="num flex-none text-[19px] leading-none"
          title="เวลาที่โชว์นี้ใช้จริง (Live Mode)"
        >
          {formatDuration(ev.last_run_seconds)}
        </div>
      )}
    </Link>
  );
}

/**
 * The desktop read-cache, reached through the bridge desktop/src/data/event-bundle.ts
 * publishes on `window`. This component is compiled into the WEB build too, where
 * "~/data/*" doesn't resolve, so it can't import that module — same reason
 * show-readiness-check.tsx pokes at the cache from shared code. Undefined in a
 * browser → every offline-data check below falls back to today's byte-only answer.
 */
type EventCacheBridge = {
  isCached: (eventId: string) => boolean;
  warm: (eventId: string) => Promise<boolean>;
};
const eventCache = (): EventCacheBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { cueiqEventCache?: EventCacheBridge }).cueiqEventCache;

export function EventsList({
  events,
  editableGroupIds,
  callTimes,
  canRunLive = true,
  canPractice = true,
  practiceRoomByGroup,
  belowHero,
  onDeleted,
}: {
  events: EventWithGroup[];
  /** Group ids the user may edit — drives the per-card duplicate button. */
  editableGroupIds: string[];
  /** Each upcoming show's call time (its earliest timed schedule row). Optional,
   *  and the difference matters: absent means the caller could not read schedules
   *  (the desktop with no cached bundle), so the call time is UNKNOWN — the banner
   *  says the stage time alone and the ticket leaves its "นัด" cell out. A map
   *  (even `{}`) means the schedules were read, so a show missing from it has no
   *  call time and its cell says "—". */
  callTimes?: Record<string, string>;
  /** canLiveEdit (admin). Anyone may RUN Live Mode to rehearse timing, but only
   *  an admin edits it live (reorder, files, "จบโชว์"), and the one real at-show
   *  run on record (2026-09-05) was an admin's. For everyone else the banner's
   *  second button is "ซ้อม" — what the band does between shows — except on the
   *  show's own day, when it is Live Mode for everyone. */
  canRunLive?: boolean;
  /** Practice is a band activity; the web redirects label staff away from it. */
  canPractice?: boolean;
  /** The practice room "ซ้อม" opens, per band (lib/next-show.ts). Absent → the
   *  Training list. */
  practiceRoomByGroup?: Record<string, string>;
  /** Rendered right under the hero (the What's New card): under the ticket, never
   *  above the one thing a member opened the app to see. */
  belowHero?: ReactNode;
  /** After a card's own delete (the card is already gone from this list): lets a page
   *  that derives something from `events` drop the show too - the desktop dashboard
   *  builds the ticket's call times from it, and a deleted ticket show must not keep
   *  deciding what the next one's "นัด" says. */
  onDeleted?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  // Local copy so a delete drops the card instantly; re-synced when the server
  // refresh brings a fresh `events` prop.
  const [items, setItems] = useState(events);
  useEffect(() => setItems(events), [events]);
  const handleDeleted = useCallback(
    (id: string) => {
      setItems((cur) => cur.filter((e) => e.id !== id));
      onDeleted?.(id);
    },
    [onDeleted]
  );
  const canEditEvent = (ev: EventWithGroup) =>
    !!ev.group_id && editableGroupIds.includes(ev.group_id);

  // Offline-prep — per-device readiness badges, the bulk "เตรียมทุกงาน" download,
  // and the storage-clear footer — is a DESKTOP-only concern now. The web app is
  // online-first + casual practice and caches a song's audio on demand when it's
  // played, so none of this runs/renders in a browser. `native` is the Electron
  // bridge (undefined in a browser); this same component is reused by the desktop
  // dashboard, where it stays fully featured.
  const native = typeof window !== "undefined" ? window.cueiqNative : undefined;

  const { upcoming, undated, past, old } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? items.filter((e) =>
          [e.name, e.venue, e.groups?.name]
            .filter(Boolean)
            .some((s) => (s as string).toLowerCase().includes(needle))
        )
      : items;
    const today = todayKey();
    const up = matched
      .filter((e) => !e.event_date || e.event_date >= today)
      // soonest date first, then by start time so same-day shows run in order
      .sort(compareUpcoming);
    const pa = matched
      .filter((e) => e.event_date && e.event_date < today)
      .sort((a, b) => {
        // most recent date first, then latest start time within the day
        const d = (b.event_date ?? "").localeCompare(a.event_date ?? "");
        return d !== 0
          ? d
          : (b.show_start_time ?? "").localeCompare(a.show_start_time ?? "");
      });
    // "งานไหนเลยเกิน 1 เดือนไปแล้ว ลบทิ้งเลย รก" (พี่, 2026-09-28) — then, shown
    // the cost (37 of 52 events, every approved show among them, setlists and
    // run times with them), chose to fold them away rather than delete. Nothing
    // leaves the database; they just stop filling the page.
    const cutoff = monthBeforeKey(today);
    return {
      // A show with no date is not "coming up" — it is unfinished. Filed under
      // กำลังจะถึง it headed the page: on 2026-09-28 the ONLY upcoming card was a
      // dateless test event from July, and a copy made without a date lands there
      // too. It gets its own heading, which is also the nudge to set one.
      upcoming: up.filter((e) => !!e.event_date),
      undated: up.filter((e) => !e.event_date),
      past: pa.filter((e) => e.event_date! >= cutoff),
      old: pa.filter((e) => e.event_date! < cutoff),
    };
  }, [items, q]);

  const [oldOpen, setOldOpen] = useState(false);
  // A search that matches only folded events must not read as "ไม่พบ" — the one
  // way a hidden-by-default list goes wrong is by hiding the answer.
  const showOld = oldOpen || q.trim() !== "";

  const noResults =
    upcoming.length === 0 && undated.length === 0 && past.length === 0 && old.length === 0;
  // soonest dated upcoming event (upcoming is already sorted soonest-first)
  const nextShow = !q.trim() ? upcoming.find((e) => !!e.event_date) : undefined;
  // With no show to take a band from: the room, when this account's bands have
  // exactly one between them (a member's case); otherwise the Training list.
  const roomIds = Object.values(practiceRoomByGroup ?? {});
  const soleRoom = roomIds.length === 1 ? roomIds[0] : null;
  const nextTimes = nextShow
    ? showTimesLabel(callTimes?.[nextShow.id], nextShow.show_start_time)
    : null;

  // all past events (search-independent) — for clearing their cached audio
  const allPastIds = useMemo(() => {
    const today = todayKey();
    return items
      .filter((e) => e.event_date && e.event_date < today)
      .map((e) => e.id);
  }, [items]);

  // Per-device offline-readiness badge on each upcoming card: does THIS device
  // already hold the event's audio AND its management bundle? Two batched queries
  // (items + songs) cover all upcoming events, then readiness is compared against
  // the IndexedDB audio cache and the desktop read-cache.
  const [readiness, setReadiness] = useState<Record<string, EventReadiness>>({});
  const [targetsByEvent, setTargetsByEvent] = useState<
    Record<string, PrefetchTarget[]>
  >({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const computeReadiness = useCallback(async () => {
    if (!native) return; // desktop-only; web plays on demand, no pre-cache badges
    const today = todayKey();
    const wanted = items.filter(
      (e) => e.group_id && (!e.event_date || e.event_date >= today)
    );
    if (wanted.length === 0) return;
    const eventIds = wanted.map((e) => e.id);
    const groupIds = Array.from(new Set(wanted.map((e) => e.group_id as string)));
    try {
      const supabase = createClient();
      const [itemsRes, songsRes] = await Promise.all([
        supabase
          .from("setlist_items")
          .select("id, song_id, audio_path, audio_name, event_id")
          .in("event_id", eventIds),
        supabase
          .from("songs")
          .select("id, audio_path, audio_name")
          .in("group_id", groupIds),
      ]);
      // A partial fetch would make targetsByEvent incomplete → a later bulk
      // "prepare all" would prune good cache as orphans. Skip on any query error.
      if (itemsRes.error || songsRes.error) return;
      // …and an EMPTY answer with no error is the same danger wearing a disguise:
      // supabase-js falls back to the anon key when getSession() returns null (an
      // expired token whose refresh failed — the ordinary state in the minute
      // after a venue reconnect), and RLS answers that with zero rows. Every
      // "เพลง 3/12" badge would vanish and "เตรียมทุกงาน" would report nothing
      // left to fetch, so the dashboard tells the operator every show is ready
      // when it may hold no audio at all. Leave the last good badges alone.
      if (
        (itemsRes.data ?? []).length === 0 &&
        (songsRes.data ?? []).length === 0 &&
        !(await hasLiveSession())
      ) {
        return;
      }
      const songAudio: SongAudioMap = Object.fromEntries(
        (songsRes.data ?? []).map((s) => [
          s.id,
          { path: s.audio_path ?? null, name: s.audio_name ?? null },
        ])
      );
      const byEvent: Record<string, NonNullable<typeof itemsRes.data>> = {};
      for (const it of itemsRes.data ?? []) {
        (byEvent[it.event_id] ??= []).push(it);
      }
      // Bytes are only half of it — without the event's bundle on disk the show
      // can't even be opened offline. No bridge (web / older shell) → assume the
      // data side is fine, so the badge behaves exactly as it did before.
      const cache = eventCache();
      const out: Record<string, EventReadiness> = {};
      const outTargets: Record<string, PrefetchTarget[]> = {};
      await Promise.all(
        wanted.map(async (e) => {
          const targets = resolveAudioTargets(byEvent[e.id] ?? [], songAudio);
          // An event with NO audio — a booth/talk day, or a setlist typed before the
          // files are uploaded — still carries ตาราง/ไมค์/ไลน์อัพ that must reach the
          // venue, so it belongs in the prepare set too. getReadiness is only ever
          // asked about real files, and prefetchEventAudio bails on an empty list by
          // design (its "never run the orphan-cleanup with an empty target list" guard).
          outTargets[e.id] = targets;
          const r: Readiness =
            targets.length > 0
              ? await getReadiness(e.id, targets)
              : { total: 0, ready: 0, stale: 0, missing: 0 };
          out[e.id] = {
            ready: r.ready,
            total: r.total,
            data: cache ? cache.isCached(e.id) : true,
          };
        })
      );
      setReadiness(out);
      setTargetsByEvent(outTargets);
    } catch {
      /* best-effort — no badge on failure */
    }
  }, [items, native]);

  // Shows still missing something across all upcoming dates — files OR the event
  // bundle — and a one-tap "prepare them all".
  const notReadyIds = useMemo(
    () =>
      Object.keys(targetsByEvent).filter((id) => {
        const r = readiness[id];
        return r && (r.ready < r.total || !r.data);
      }),
    [targetsByEvent, readiness]
  );

  const prepareAll = useCallback(async () => {
    const todo = notReadyIds;
    if (todo.length === 0) return;
    const cache = eventCache();
    const grandTotal = todo.reduce((n, id) => {
      const r = readiness[id];
      // + 1 step for an event whose bundle still has to be pulled down (same
      // condition the loop below uses, so the counter can't overshoot)
      return n + (r ? r.total - r.ready : 0) + (cache && r && !r.data ? 1 : 0);
    }, 0);
    setBulk({ done: 0, total: grandTotal });
    let done = 0;
    for (const id of todo) {
      const r = readiness[id];
      // Data first: it's tiny next to the audio, and an event whose run sheet is
      // cached can at least be OPENED offline if the transfer is cut short later.
      // Swallow per event — one unreachable show must not abort the whole run.
      if (cache && r && !r.data) {
        await cache.warm(id).catch(() => {});
        done += 1;
        setBulk({ done, total: grandTotal });
      }
      await prefetchEventAudio(id, targetsByEvent[id] ?? [], {
        onProgress: (p) => setBulk({ done: done + p.done, total: grandTotal }),
      });
      done += r ? r.total - r.ready : 0;
    }
    setBulk(null);
    computeReadiness();
  }, [notReadyIds, readiness, targetsByEvent, computeReadiness]);

  useEffect(() => {
    if (!native) return; // desktop-only — skip the readiness polling on the web
    computeReadiness();
    const onVisible = () => {
      if (document.visibilityState === "visible") computeReadiness();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", computeReadiness);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", computeReadiness);
    };
  }, [computeReadiness, native]);

  // ---- the hero (spec §G.1) — plain values, no hooks below this line ----
  const days = nextShow?.event_date ? daysUntil(nextShow.event_date) : null;
  const nextDp = dateParts(nextShow?.event_date);
  const nextStage = shortClock(nextShow?.show_start_time) || null;
  const nextCallRaw = shortClock(nextShow ? callTimes?.[nextShow.id] : null) || null;
  // A call that IS the stage time is said once (showTimesLabel does the same).
  const nextCall = nextCallRaw && nextCallRaw !== nextStage ? nextCallRaw : null;
  const nextHardOut = shortClock(nextShow?.hard_out_time) || null;
  // The ticket's stub cells. "นัด" only when the caller read schedules (see its cell).
  const timeCells: [label: string, value: string | null][] = [
    ...(callTimes ? [["นัด", nextCall] as [string, string | null]] : []),
    ["ขึ้นเวที", nextStage],
    ["Hard Out", nextHardOut],
  ];
  // canLiveEdit (admin), no band practice (label staff), or the show's own day →
  // Live Mode; otherwise the band practises the set (see the prop notes above).
  const liveLeads = canRunLive || !canPractice || (days ?? 1) <= 0;
  // "ซ้อมตามเซ็ต" is the word for the band's ROOM; with none known the button opens
  // the Training list and says "ห้องซ้อม" — what the event page's hero does
  // (components/event/event-hero.tsx), so the same button never lies in one place.
  const practiceRoom = nextShow?.group_id ? practiceRoomByGroup?.[nextShow.group_id] : undefined;
  const practiceHref = practiceRoom ? `/events/${practiceRoom}/practice` : "/practice";
  // Desktop only (`native`): one tap to pull every upcoming show onto this machine.
  const prepareBtn =
    notReadyIds.length > 0 || bulk ? (
      <button
        type="button"
        onClick={prepareAll}
        disabled={!!bulk}
        title="โหลดข้อมูลงานและไฟล์เพลงของทุกงานที่กำลังจะถึงลงเครื่องนี้ไว้ก่อน"
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[3px] bg-muted px-3 text-sm font-medium text-muted-foreground shadow-edge transition hover:text-foreground disabled:opacity-70"
      >
        {bulk ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            กำลังเตรียม {bulk.done}/{bulk.total}
          </>
        ) : (
          <>
            <DownloadCloud className="h-4 w-4" />
            เตรียมทุกงานที่จะถึง ({notReadyIds.length})
          </>
        )}
      </button>
    ) : null;
  // The show the ticket above is about — its stub below need not say its deadline twice.
  const ticketId = nextShow?.event_date ? nextShow.id : null;
  const stubs = (list: EventWithGroup[]) => (
    <div className="flex flex-col gap-[2px] sm:grid sm:grid-cols-2 sm:gap-2 lg:grid-cols-3">
      {list.map((ev) => (
        <EventStub
          key={ev.id}
          ev={ev}
          onTicket={ev.id === ticketId}
          editable={canEditEvent(ev)}
          readiness={readiness[ev.id]}
          onDeleted={handleDeleted}
        />
      ))}
    </div>
  );
  const pastRows = (list: EventWithGroup[]) => (
    <div className="stack">
      {list.map((ev) => (
        <PastRow key={ev.id} ev={ev} editable={canEditEvent(ev)} onDeleted={handleDeleted} />
      ))}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* The next show as a ticket — the screen's one lit surface. Not a link
          itself: its two buttons are the ways in, and a link around links is
          invalid. Its numerals are never band-coloured (spec §0.3 rule 3). */}
      {nextShow && nextShow.event_date && (
        <section
          aria-label="Next show"
          className="ticket lit cut sweep"
          style={{ "--cut": "22px", "--stub-h": "126px" } as CSSProperties}
        >
          <div className="px-4 pb-3 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="eyebrow key">Next Show</span>
              <StatusBadge status={nextShow.status as GroupStatus} className="shrink-0" />
            </div>
            {/* Thai order: "อีก [3] วัน" — the count set big between its words. */}
            <div className="mt-1 flex items-end">
              {days != null && days <= 0 ? (
                <>
                  <span className="pb-[1px] text-[30px] font-semibold">วันนี้</span>
                  {nextStage && (
                    <span className="num ml-3 pb-[2px] text-[50px] font-extrabold leading-[.86]">
                      {nextStage}
                    </span>
                  )}
                </>
              ) : days === 1 ? (
                <span className="pb-[1px] text-[30px] font-semibold">พรุ่งนี้</span>
              ) : (
                <>
                  <span className="pb-[5px] pr-2 text-[18px] font-medium text-muted-foreground">อีก</span>
                  {/* 3 digits at 144 px overrun a 390 px phone; 96 px keeps the row in. */}
                  <span className={cn("hero-num hard-drop slam", days != null && days > 99 && "text-[96px]")}>
                    {days}
                  </span>
                  <span className="pb-[1px] pl-4 text-[30px] font-semibold">วัน</span>
                </>
              )}
              {nextDp && (
                <div className="ml-auto pb-[1px] pl-2 text-right">
                  <div className="eyebrow text-muted-foreground">{nextDp.wd}</div>
                  <div className="num mt-[3px] text-[50px] font-extrabold leading-[.86]">{nextDp.day}</div>
                  <div className="eyebrow mt-[4px] whitespace-nowrap text-muted-foreground">
                    {nextDp.mon} {nextDp.year}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-2.5">
              <TitleSlab name={nextShow.name ?? ""} size={38} kickerSize={16} />
            </div>
            {nextShow.venue && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <MapPin aria-hidden className="h-[15px] w-[15px] flex-none" />
                <span className="truncate">{nextShow.venue}</span>
              </div>
            )}
            <DeadlineChip
              deadline={nextShow.deadline}
              exempt={nextShow.groups?.exempt_from_deadline}
              className="mt-1.5"
            />
            {/* "นัด 11:20 · ขึ้นเวที 13:20" said once, whole, for a screen reader —
                the stub below sets the same numbers apart for the eye (lib/next-show.ts). */}
            {nextTimes && (
              <p data-testid="next-show-times" className="sr-only">
                {nextTimes}
              </p>
            )}
          </div>
          <div className="perf" aria-hidden />
          <div className="flex h-[126px] flex-col px-4 pt-2.5">
            {/* No callTimes prop at all = the caller has no schedules to read (the
                desktop with nothing cached), so the call time is UNKNOWN — and an
                "นัด —" would say "there is none". Its cell is left out, and the other
                two keep their places on a two-column grid. An empty map is different:
                every schedule was read and this show has no call. */}
            <div className={cn("grid gap-3", callTimes ? "grid-cols-3" : "grid-cols-2")}>
              {timeCells.map(([label, value]) => (
                <div key={label} className="min-w-0" aria-hidden={label !== "Hard Out" || undefined}>
                  <div className="flex items-center gap-1.5 text-[12px] leading-none text-muted-foreground">
                    {label === "ขึ้นเวที" && <i className="h-[11px] w-[3px] bg-primary" />}
                    {label}
                  </div>
                  <div className="num mt-[3px] text-[30px] leading-none">{value ?? "—"}</div>
                </div>
              ))}
            </div>
            <div className="mb-3 mt-auto grid grid-cols-[1.5fr_1fr] gap-2">
              {liveLeads ? (
                <Button asChild className="px-2">
                  <Link href={`/events/${nextShow.id}/live`}>
                    <Radio aria-hidden />
                    <span className="en">Live Mode</span>
                  </Link>
                </Button>
              ) : (
                <Button asChild className="px-2">
                  <Link href={practiceHref}>
                    <Headphones aria-hidden />
                    {practiceRoom ? "ซ้อมตามเซ็ต" : "ห้องซ้อม"}
                  </Link>
                </Button>
              )}
              <Button asChild variant="secondary" className="px-2">
                <Link href={`/events/${nextShow.id}`}>
                  <CalendarDays aria-hidden />
                  ดูงาน
                </Link>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Between shows. The band enters a show 1–3 days before it (measured), so
          for most of the week there is no ticket — and with it went the one-tap
          "ซ้อม", in exactly the days the band practises. Said plainly, with the
          practice room as the screen's hero instead of a page of past shows. */}
      {!q.trim() && !nextShow && !canRunLive && canPractice && (
        <div data-testid="no-next-show" className="space-y-3">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <CalendarDays aria-hidden className="h-[15px] w-[15px] flex-none" />
            ยังไม่มีงานที่จะถึงในระบบ — Ar จะเพิ่มเมื่อยืนยันแล้ว
          </p>
          <section
            aria-label="Practice room"
            className="lit cut sweep p-4"
            style={{ "--cut": "22px" } as CSSProperties}
          >
            <span className="eyebrow key">Practice Room</span>
            <div className="mt-3.5 grid grid-cols-[1.6fr_1fr] gap-2">
              <Button asChild className="h-12">
                <Link href={soleRoom ? `/events/${soleRoom}/practice` : "/practice"}>
                  <Headphones aria-hidden />
                  เข้าห้องซ้อม
                </Link>
              </Button>
              <Button asChild variant="secondary" className="h-12">
                <Link href="/library">
                  <Disc3 aria-hidden />
                  <span className="en">Library</span>
                </Link>
              </Button>
            </div>
          </section>
        </div>
      )}

      {belowHero}

      {!noResults && upcoming.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
            <h2 className="h2">Upcoming</h2>
            <span className="text-[12.5px] text-muted-foreground">กำลังจะถึง · {upcoming.length}</span>
            {prepareBtn && <span className="ml-auto">{prepareBtn}</span>}
          </div>
          {stubs(upcoming)}
        </section>
      )}
      {!noResults && undated.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
            <h2 className="h2">No Date</h2>
            <span className="text-[12.5px] text-muted-foreground">ยังไม่ได้ใส่วันที่ · {undated.length}</span>
          </div>
          {stubs(undated)}
        </section>
      )}

      {/* Search sits below what is coming up: the first screen is for the next
          show, and finding an old one is the rarer errand. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            type="search"
            enterKeyHint="search"
            placeholder="ค้นหางาน / สถานที่ / วง…"
            aria-label="ค้นหางาน"
            className={cn("h-[46px] w-full pl-10 pr-3 text-base sm:text-sm", FIELD)}
          />
        </div>
        {upcoming.length === 0 && prepareBtn}
      </div>

      {noResults ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          ไม่พบงานที่ตรงกับ “{q}”
        </p>
      ) : (
        <>
          {past.length > 0 && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
                <h2 className="h2">Past</h2>
                <span className="text-[12.5px] text-muted-foreground">ผ่านมาแล้ว · {past.length}</span>
              </div>
              {pastRows(past)}
            </section>
          )}
          {old.length > 0 && (
            <section className="space-y-2">
              {q.trim() ? (
                <h2 className="px-0.5 text-[12.5px] font-semibold text-muted-foreground">
                  งานเก่า (เกิน 1 เดือน) · {old.length}
                </h2>
              ) : (
                <button
                  type="button"
                  onClick={() => setOldOpen((v) => !v)}
                  aria-expanded={showOld}
                  className="flex h-11 w-full items-center justify-between gap-3 rounded-[2px] bg-muted px-4 text-left text-sm font-semibold text-muted-foreground shadow-edge transition-colors hover:bg-muted/80"
                >
                  <span>งานเก่า (เกิน 1 เดือน) · {old.length}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
                    {showOld ? "ซ่อน" : "กดดู"}
                    <ChevronDown
                      className={cn("h-4 w-4 transition-transform", showOld && "rotate-180")}
                    />
                  </span>
                </button>
              )}
              {showOld && pastRows(old)}
            </section>
          )}
        </>
      )}

      {native && (
        <DeviceStorage pastEventIds={allPastIds} onChanged={computeReadiness} />
      )}
    </div>
  );
}
