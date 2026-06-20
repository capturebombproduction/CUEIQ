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
import { AutoPrefetch } from "@/components/event/auto-prefetch";
import { DeviceStorage } from "@/components/event/device-storage";
import { createClient } from "@/lib/supabase/client";
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
import { shortClock, deadlineInfo, formatDuration } from "@/lib/time";
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

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function countdownLabel(n: number): string {
  if (n <= 0) return "วันนี้!";
  if (n === 1) return "พรุ่งนี้";
  return `อีก ${n} วัน`;
}

function OfflineReadyBadge({ r }: { r: { ready: number; total: number } }) {
  if (r.total === 0) return null;
  const done = r.ready >= r.total;
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
          ? "ไฟล์เพลงของงานนี้อยู่ในเครื่องนี้ครบแล้ว เล่นได้แม้เน็ตหลุด"
          : "เครื่องนี้ยังโหลดเพลงไม่ครบ — เปิดงานแล้วกด ‘เตรียมเครื่องนี้’"
      }
    >
      {done ? (
        <>
          <CheckCircle2 className="h-3.5 w-3.5" /> พร้อมออฟไลน์
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
}: {
  ev: EventWithGroup;
  editable: boolean;
  readiness?: { ready: number; total: number };
}) {
  return (
    <Link href={`/events/${ev.id}`} className="group">
      <Card
        className="relative h-full overflow-hidden border-l-4 transition-shadow group-hover:shadow-md"
        style={ev.groups?.color ? { borderLeftColor: ev.groups.color } : undefined}
      >
        {editable && <DuplicateEventButton eventId={ev.id} />}
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

export function EventsList({
  events,
  editable,
}: {
  events: EventWithGroup[];
  editable: boolean;
}) {
  const [q, setQ] = useState("");

  const { upcoming, past } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? events.filter((e) =>
          [e.name, e.venue, e.groups?.name]
            .filter(Boolean)
            .some((s) => (s as string).toLowerCase().includes(needle))
        )
      : events;
    const today = todayKey();
    const up = matched
      .filter((e) => !e.event_date || e.event_date >= today)
      .sort((a, b) => (a.event_date ?? "9999").localeCompare(b.event_date ?? "9999"));
    const pa = matched
      .filter((e) => e.event_date && e.event_date < today)
      .sort((a, b) => (b.event_date ?? "").localeCompare(a.event_date ?? ""));
    return { upcoming: up, past: pa };
  }, [events, q]);

  const noResults = upcoming.length === 0 && past.length === 0;
  // soonest dated upcoming event (upcoming is already sorted soonest-first)
  const nextShow = !q.trim() ? upcoming.find((e) => !!e.event_date) : undefined;

  // all past events (search-independent) — for clearing their cached audio
  const allPastIds = useMemo(() => {
    const today = todayKey();
    return events
      .filter((e) => e.event_date && e.event_date < today)
      .map((e) => e.id);
  }, [events]);

  // Per-device offline-readiness badge on each upcoming card: does THIS device
  // already hold the event's audio? Two batched queries (items + songs) cover all
  // upcoming events, then readiness is compared against the IndexedDB cache.
  const [readiness, setReadiness] = useState<
    Record<string, { ready: number; total: number }>
  >({});
  const [targetsByEvent, setTargetsByEvent] = useState<
    Record<string, PrefetchTarget[]>
  >({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const computeReadiness = useCallback(async () => {
    const today = todayKey();
    const wanted = events.filter(
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
      const out: Record<string, { ready: number; total: number }> = {};
      const outTargets: Record<string, PrefetchTarget[]> = {};
      await Promise.all(
        wanted.map(async (e) => {
          const targets = resolveAudioTargets(byEvent[e.id] ?? [], songAudio);
          if (targets.length === 0) return;
          outTargets[e.id] = targets;
          const r: Readiness = await getReadiness(e.id, targets);
          out[e.id] = { ready: r.ready, total: r.total };
        })
      );
      setReadiness(out);
      setTargetsByEvent(outTargets);
    } catch {
      /* best-effort — no badge on failure */
    }
  }, [events]);

  // Files still missing across all upcoming shows, and a one-tap "prepare them all".
  const notReadyIds = useMemo(
    () =>
      Object.keys(targetsByEvent).filter((id) => {
        const r = readiness[id];
        return r && r.ready < r.total;
      }),
    [targetsByEvent, readiness]
  );

  const prepareAll = useCallback(async () => {
    const todo = notReadyIds;
    if (todo.length === 0) return;
    const grandTotal = todo.reduce((n, id) => {
      const r = readiness[id];
      return n + (r ? r.total - r.ready : 0);
    }, 0);
    setBulk({ done: 0, total: grandTotal });
    let done = 0;
    for (const id of todo) {
      await prefetchEventAudio(id, targetsByEvent[id] ?? [], {
        onProgress: (p) => setBulk({ done: done + p.done, total: grandTotal }),
      });
      const r = readiness[id];
      done += r ? r.total - r.ready : 0;
    }
    setBulk(null);
    computeReadiness();
  }, [notReadyIds, readiness, targetsByEvent, computeReadiness]);

  useEffect(() => {
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
  }, [computeReadiness]);

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
          {nextShow.group_id && (
            <AutoPrefetch eventId={nextShow.id} groupId={nextShow.group_id} />
          )}
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
            title="โหลดไฟล์เพลงของทุกงานที่กำลังจะถึงลงเครื่องนี้ไว้ก่อน"
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
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {upcoming.map((ev) => (
                  <EventCard
                    key={ev.id}
                    ev={ev}
                    editable={editable}
                    readiness={readiness[ev.id]}
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
              <div className="grid gap-4 opacity-80 sm:grid-cols-2 lg:grid-cols-3">
                {past.map((ev) => (
                  <EventCard key={ev.id} ev={ev} editable={editable} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <DeviceStorage pastEventIds={allPastIds} onChanged={computeReadiness} />
    </div>
  );
}
