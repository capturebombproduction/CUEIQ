"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, MapPin, Music2, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { DuplicateEventButton } from "@/components/event/duplicate-event-button";
import {
  EVENT_TYPES,
  type EventRow,
  type EventType,
  type GroupStatus,
} from "@/lib/types";
import { shortClock } from "@/lib/time";

type EventWithGroup = EventRow & {
  groups: { name: string; color: string | null } | null;
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

function EventCard({
  ev,
  editable,
}: {
  ev: EventWithGroup;
  editable: boolean;
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

  return (
    <div className="space-y-6">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหางาน / สถานที่ / วง…"
          className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm outline-none ring-primary/40 focus:ring-2"
        />
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
                  <EventCard key={ev.id} ev={ev} editable={editable} />
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
    </div>
  );
}
