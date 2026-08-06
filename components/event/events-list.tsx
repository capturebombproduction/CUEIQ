"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  MapPin,
  Music2,
  Search,
  Radio,
  AlarmClock,
  Timer,
  CheckCircle2,
  HardDriveDownload,
  Loader2,
  DownloadCloud,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { DuplicateEventButton } from "@/components/event/duplicate-event-button";
import { DeleteEventButton } from "@/components/event/delete-event-button";
import { DeviceStorage } from "@/components/event/device-storage";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import {
  getReadiness,
  prefetchEventAudio,
  type Readiness,
  type PrefetchTarget,
} from "@/lib/audio-prefetch";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";
import {
  EVENT_TYPES,
  type EventRow,
  type EventType,
  type GroupStatus,
} from "@/lib/types";
import { shortClock, deadlineInfo, formatDuration, bkkTodayKey } from "@/lib/time";
import { cn } from "@/lib/utils";

type EventWithGroup = EventRow & {
  groups: {
    name: string;
    color: string | null;
    exempt_from_deadline?: boolean;
  } | null;
};

const DEADLINE_TONE: Record<string, string> = {
  overdue: "bg-destructive text-destructive-foreground",
  urgent: "bg-orange-500 text-white",
  soon: "bg-amber-400 text-black",
  ok: "bg-muted text-muted-foreground",
};

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

function countdownLabel(n: number): string {
  if (n <= 0) return "วันนี้!";
  if (n === 1) return "พรุ่งนี้";
  return `อีก ${n} วัน`;
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
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        done
          ? "bg-green-600/10 text-green-700 dark:text-green-400"
          : "bg-muted text-muted-foreground"
      )}
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
          <CheckCircle2 className="h-3.5 w-3.5" /> พร้อมออฟไลน์
        </>
      ) : bytesDone ? (
        <>
          <HardDriveDownload className="h-3.5 w-3.5" /> ยังไม่มีข้อมูลงาน
        </>
      ) : (
        <>
          <HardDriveDownload className="h-3.5 w-3.5" /> เพลง {r.ready}/{r.total}
        </>
      )}
    </span>
  );
}

function EventCard({
  ev,
  editable,
  readiness,
  onDeleted,
}: {
  ev: EventWithGroup;
  editable: boolean;
  readiness?: EventReadiness;
  onDeleted?: (id: string) => void;
}) {
  return (
    <Link href={`/events/${ev.id}`} className="group">
      <Card
        className="relative h-full overflow-hidden border-l-4 transition-shadow group-hover:shadow-md"
        style={ev.groups?.color ? { borderLeftColor: ev.groups.color } : undefined}
      >
        {editable && (
          <>
            <DuplicateEventButton eventId={ev.id} />
            <DeleteEventButton eventId={ev.id} eventName={ev.name} onDeleted={onDeleted} />
          </>
        )}
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
                <span className="tabular-nums">· {shortClock(ev.show_start_time)}</span>
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
              {EVENT_TYPES[ev.event_type as EventType]?.label ?? ev.event_type}
            </p>
            {ev.last_run_seconds != null && (
              <p className="flex items-center gap-2">
                <Timer className="h-4 w-4 shrink-0" />
                โชว์ล่าสุดใช้เวลา{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {formatDuration(ev.last_run_seconds)}
                </span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(() => {
              if (ev.groups?.exempt_from_deadline) return null;
              const dl = deadlineInfo(ev.deadline);
              if (!dl) return null;
              return (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
                    DEADLINE_TONE[dl.tone]
                  )}
                >
                  <AlarmClock className="h-3.5 w-3.5" /> {dl.label}
                </span>
              );
            })()}
            {readiness && <OfflineReadyBadge r={readiness} />}
          </div>
        </CardContent>
      </Card>
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
}: {
  events: EventWithGroup[];
  /** Group ids the user may edit — drives the per-card duplicate button. */
  editableGroupIds: string[];
}) {
  const [q, setQ] = useState("");
  // Local copy so a delete drops the card instantly; re-synced when the server
  // refresh brings a fresh `events` prop.
  const [items, setItems] = useState(events);
  useEffect(() => setItems(events), [events]);
  const handleDeleted = useCallback(
    (id: string) => setItems((cur) => cur.filter((e) => e.id !== id)),
    []
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

  const { upcoming, past } = useMemo(() => {
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
      .sort((a, b) => {
        // soonest date first, then by start time so same-day shows run in order
        const d = (a.event_date ?? "9999").localeCompare(b.event_date ?? "9999");
        return d !== 0
          ? d
          : (a.show_start_time ?? "99:99:99").localeCompare(b.show_start_time ?? "99:99:99");
      });
    const pa = matched
      .filter((e) => e.event_date && e.event_date < today)
      .sort((a, b) => {
        // most recent date first, then latest start time within the day
        const d = (b.event_date ?? "").localeCompare(a.event_date ?? "");
        return d !== 0
          ? d
          : (b.show_start_time ?? "").localeCompare(a.show_start_time ?? "");
      });
    return { upcoming: up, past: pa };
  }, [items, q]);

  const noResults = upcoming.length === 0 && past.length === 0;
  // soonest dated upcoming event (upcoming is already sorted soonest-first)
  const nextShow = !q.trim() ? upcoming.find((e) => !!e.event_date) : undefined;

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

  return (
    <div className="space-y-6">
      {nextShow && nextShow.event_date && (
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-l-4 bg-card p-4 shadow-sm"
          style={nextShow.groups?.color ? { borderLeftColor: nextShow.groups.color } : undefined}
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              งานถัดไป
            </div>
            <div className="truncate text-lg font-bold leading-tight">{nextShow.name}</div>
            <div className="truncate text-sm text-muted-foreground">
              {formatDate(nextShow.event_date)}
              {nextShow.show_start_time && (
                <span className="tabular-nums"> · {shortClock(nextShow.show_start_time)}</span>
              )}
              {nextShow.venue && <span> · {nextShow.venue}</span>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-extrabold text-primary">
              {countdownLabel(daysUntil(nextShow.event_date))}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href={`/events/${nextShow.id}`}
              className="rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted"
            >
              ดูงาน
            </Link>
            <Link
              href={`/events/${nextShow.id}/live`}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
            >
              <Radio className="h-4 w-4" /> Live Mode
            </Link>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหางาน / สถานที่ / วง…"
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        </div>
        {(notReadyIds.length > 0 || bulk) && (
          <button
            type="button"
            onClick={prepareAll}
            disabled={!!bulk}
            title="โหลดข้อมูลงานและไฟล์เพลงของทุกงานที่กำลังจะถึงลงเครื่องนี้ไว้ก่อน"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70"
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
        )}
      </div>

      {noResults ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          ไม่พบงานที่ตรงกับ “{q}”
        </p>
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                กำลังจะถึง · {upcoming.length}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {upcoming.map((ev) => (
                  <EventCard
                    key={ev.id}
                    ev={ev}
                    editable={canEditEvent(ev)}
                    readiness={readiness[ev.id]}
                    onDeleted={handleDeleted}
                  />
                ))}
              </div>
            </section>
          )}
          {past.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                ผ่านมาแล้ว · {past.length}
              </h2>
              <div className="grid grid-cols-1 gap-4 opacity-80 sm:grid-cols-2 lg:grid-cols-3">
                {past.map((ev) => (
                  <EventCard
                    key={ev.id}
                    ev={ev}
                    editable={canEditEvent(ev)}
                    onDeleted={handleDeleted}
                  />
                ))}
              </div>
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
