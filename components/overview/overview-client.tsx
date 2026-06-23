"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlarmClock, Users, PlayCircle, ImageDown, Loader2 } from "lucide-react";
import { EventStatusActions } from "@/components/overview/event-status-actions";
import { PhotoTimeCell } from "@/components/overview/photo-time-cell";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { shortClock, deadlineInfo } from "@/lib/time";
import { captureElementToImage } from "@/lib/export-image";
import type { GroupStatus, StaffContact } from "@/lib/types";

/** A start→end clock window; end is optional (single time when absent). */
type TimeRange = { start: string | null; end: string | null } | null;

export interface OverviewEvent {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
  group_color: string | null;
  exempt_from_deadline: boolean;
  event_date: string | null;
  status: GroupStatus;
  deadline: string | null;
  stage: TimeRange;
  booth: TimeRange;
  photo: string | null; // start (inline-editable via PhotoTimeCell)
  photoEnd: string | null; // end of the photo window
  // inline-action support
  tenant_id: string;
  canEditPhoto: boolean; // band is self_photo=false AND viewer may set photo time
  photoItemId: string | null; // the photo schedule_item to update (null = none yet)
  photoSortOrder: number; // sort_order to use when inserting a new photo row
  copyrightPending: number; // library songs in this event's setlist awaiting review
  copyrightRejected: number; // library songs in this event's setlist rejected
}

export interface OverviewBand {
  id: string;
  name: string;
  color: string | null;
  contact_name: string | null; // band's point of contact (staff schedule export)
  contact_phone: string | null;
  members: { id: string; label: string; mic_number: number | null }[];
}

type ViewMode = "band" | "event" | "day" | "week" | "month" | "year";

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "band", label: "รายวง" },
  { value: "event", label: "รายงาน" },
  { value: "day", label: "รายวัน" },
  { value: "week", label: "รายสัปดาห์" },
  { value: "month", label: "รายเดือน" },
  { value: "year", label: "รายปี" },
];

const DEADLINE_BADGE: Record<string, string> = {
  overdue: "bg-destructive text-destructive-foreground",
  urgent: "bg-orange-500 text-white",
  soon: "bg-amber-400 text-black",
  ok: "bg-muted text-muted-foreground",
};

function fmtDate(date: string | null): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-CA"); // ISO YYYY-MM-DD, e.g. 2026-06-21
}

// Stage/Booth time window: "12:00–12:20", or just "12:00" when no end is set.
function fmtRange(r: TimeRange): string {
  if (!r || (!r.start && !r.end)) return "—";
  const start = shortClock(r.start) || "—";
  return r.end ? `${start}–${shortClock(r.end)}` : start;
}

// ISO date with weekday for the date picker / export subtitle: "2026-06-21 · Sat".
function fmtDateWd(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return `${d.toLocaleDateString("en-CA")} · ${d.toLocaleDateString("en-GB", {
    weekday: "short",
  })}`;
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Mon = 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

const NO_DATE_KEY = "zzz-no-date";

// Map an event to a time-bucket {key (sortable), label} for week/month/year views.
function bucketOf(ev: OverviewEvent, mode: ViewMode): { key: string; label: string } {
  if (!ev.event_date) return { key: NO_DATE_KEY, label: "ไม่ระบุวันที่" };
  const d = new Date(`${ev.event_date}T00:00:00`);
  if (isNaN(d.getTime())) return { key: NO_DATE_KEY, label: "ไม่ระบุวันที่" };
  if (mode === "day") {
    const iso = d.toLocaleDateString("en-CA"); // 2026-06-21
    const wd = d.toLocaleDateString("en-GB", { weekday: "short" }); // Sat
    return { key: iso, label: `${iso} · ${wd}` };
  }
  if (mode === "year") {
    const y = d.getFullYear();
    return { key: String(y), label: String(y) };
  }
  if (mode === "month") {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    // en-GB Gregorian to match the row date column ("20 Jun") rather than th-TH BE.
    const label = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    return { key, label };
  }
  // week
  const ws = startOfWeek(d);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const key = `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, "0")}-${String(
    ws.getDate()
  ).padStart(2, "0")}`;
  const fmt = (x: Date) =>
    x.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return { key, label: `${fmt(ws)} – ${fmt(we)}` };
}

// Minutes since midnight for a "HH:MM[:SS]" clock, for time-ordering the schedule.
function toMinutes(t: string): number {
  const [h, m] = t.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}
// An event's EARLIEST scheduled activity (stage / booth / photo start). Shows with
// no time set sort last so they don't jump ahead of timed ones.
function earliestMinutes(ev: OverviewEvent): number {
  const starts = [ev.stage?.start, ev.booth?.start, ev.photo].filter(
    (t): t is string => !!t
  );
  return starts.length
    ? Math.min(...starts.map(toMinutes))
    : Number.POSITIVE_INFINITY;
}

interface Bucket {
  key: string;
  label: string;
  color?: string | null;
  date?: string | null; // report view: the shared event date, shown in the header
  events: OverviewEvent[];
}

// --- Shared cell renderers — used by BOTH the desktop table and the mobile
// cards so the interactive bits (detail link, Live, copyright badges, photo-time
// edit, status actions) live in one place. ---

// View-only Live link (overview audience). copyright-status badges that deep-link
// to the library. Shared by the event-name cell and the compact report row.
function LiveLink({ ev }: { ev: OverviewEvent }) {
  return (
    <Link
      href={`/events/${ev.id}/live`}
      title="เปิด Live (ดูอย่างเดียว)"
      className="text-muted-foreground hover:text-primary"
    >
      <PlayCircle className="h-4 w-4" />
    </Link>
  );
}

function CopyrightBadges({ ev }: { ev: OverviewEvent }) {
  if (ev.copyrightRejected > 0) {
    return (
      <Link
        href="/library"
        title={`${ev.copyrightRejected} เพลงถูกปฏิเสธลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
        className="inline-flex items-center gap-0.5 rounded bg-destructive/15 px-1 text-xs font-semibold text-destructive"
      >
        ⛔ {ev.copyrightRejected}
      </Link>
    );
  }
  if (ev.copyrightPending > 0) {
    return (
      <Link
        href="/library"
        title={`${ev.copyrightPending} เพลงรอตรวจลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
        className="inline-flex items-center gap-0.5 rounded bg-amber-400/20 px-1 text-xs font-semibold text-amber-700 dark:text-amber-400"
      >
        🕒 {ev.copyrightPending}
      </Link>
    );
  }
  return null;
}

function EventNameCell({
  ev,
  canOpenDetail,
  isLabelWide,
}: {
  ev: OverviewEvent;
  canOpenDetail: boolean;
  isLabelWide: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {canOpenDetail ? (
        <Link
          href={`/events/${ev.id}`}
          className="break-words font-medium hover:text-primary hover:underline"
        >
          {ev.name}
        </Link>
      ) : (
        <span className="break-words font-medium">{ev.name}</span>
      )}
      {isLabelWide && <LiveLink ev={ev} />}
      <CopyrightBadges ev={ev} />
    </div>
  );
}

function BandTag({ ev }: { ev: OverviewEvent }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ background: ev.group_color || "var(--primary)" }}
      />
      {ev.group_name}
    </span>
  );
}

function PhotoCell({ ev }: { ev: OverviewEvent }) {
  return ev.canEditPhoto ? (
    <PhotoTimeCell
      eventId={ev.id}
      tenantId={ev.tenant_id}
      initialItemId={ev.photoItemId}
      initialTime={ev.photo}
      initialEnd={ev.photoEnd}
      nextSortOrder={ev.photoSortOrder}
    />
  ) : (
    <>{fmtRange({ start: ev.photo, end: ev.photoEnd })}</>
  );
}

function DeadlineCell({ ev }: { ev: OverviewEvent }) {
  const dl = ev.exempt_from_deadline ? null : deadlineInfo(ev.deadline);
  return dl ? (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
        DEADLINE_BADGE[dl.tone]
      )}
    >
      <AlarmClock className="h-3 w-3" /> {dl.label}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  );
}

function StatusCell({
  ev,
  canApproveEvents,
  compact = false,
}: {
  ev: OverviewEvent;
  canApproveEvents: boolean;
  compact?: boolean; // tight rows (รายงาน): colour dot only, no text badge
}) {
  return canApproveEvents ? (
    <EventStatusActions
      eventId={ev.id}
      initialStatus={ev.status}
      eventName={ev.name}
      compact={compact}
    />
  ) : compact ? (
    // Phone: text badge (no hover on touch); wide single-row: colour dot only.
    <>
      <StatusBadge status={ev.status} className="sm:hidden" />
      <StatusDot status={ev.status} className="hidden sm:inline-block" />
    </>
  ) : (
    <StatusBadge status={ev.status} />
  );
}

// One show as a vertical card (mobile) — everything visible, no horizontal scroll.
function EventCard({
  ev,
  showBand,
  canOpenDetail,
  isLabelWide,
  canApproveEvents,
}: {
  ev: OverviewEvent;
  showBand: boolean;
  canOpenDetail: boolean;
  isLabelWide: boolean;
  canApproveEvents: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <EventNameCell ev={ev} canOpenDetail={canOpenDetail} isLabelWide={isLabelWide} />
        </div>
        <div className="shrink-0">
          <StatusCell ev={ev} canApproveEvents={canApproveEvents} />
        </div>
      </div>
      {showBand && (
        <div className="text-sm">
          <BandTag ev={ev} />
        </div>
      )}
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">วันที่</dt>
        <dd className="tabular-nums">{fmtDate(ev.event_date)}</dd>
        <dt className="text-muted-foreground">Stage</dt>
        <dd className="tabular-nums">{fmtRange(ev.stage)}</dd>
        <dt className="text-muted-foreground">Booth</dt>
        <dd className="tabular-nums">{fmtRange(ev.booth)}</dd>
        <dt className="text-muted-foreground">Photo</dt>
        <dd className="tabular-nums">
          <PhotoCell ev={ev} />
        </dd>
        <dt className="text-muted-foreground">เดดไลน์</dt>
        <dd>
          <DeadlineCell ev={ev} />
        </dd>
      </dl>
    </div>
  );
}

// One time value for the compact report row. On a phone it carries its own label
// ("Stage 10:00–10:30") since the stacked rows have no shared header; on a wide
// screen the label is dropped — the STAGE/BOOTH/PHOTO column header above the group
// labels them ONCE — and `className` fixes the column width so values line up.
function TimeBit({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <span className="text-xs font-medium uppercase text-muted-foreground sm:hidden">
        {label}
      </span>
      <span>{children}</span>
    </span>
  );
}

// A single show in the compact "รายงาน" view. On a phone (portrait) it's two tidy
// rows — BAND + tappable status on top, the three times (Stage / Booth / Photo)
// below. On a wider screen (landscape phone / laptop, ≥sm) it collapses to ONE line
// — band, then the times, then the status at the far right — using the horizontal
// room a phone doesn't have. The band sits in a fixed column so the Stage time lines
// up row-to-row. Event name + date live in the group header above; the deadline chip
// shows only when it matters (soon / urgent / overdue).
function EventScheduleRow({
  ev,
  canOpenDetail,
  isLabelWide,
  canApproveEvents,
}: {
  ev: OverviewEvent;
  canOpenDetail: boolean;
  isLabelWide: boolean;
  canApproveEvents: boolean;
}) {
  const dl = ev.exempt_from_deadline ? null : deadlineInfo(ev.deadline);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm">
      {/* Band — fixed column on wide screens so the Stage time aligns row-to-row */}
      <div className="order-1 flex min-w-0 items-center gap-2 font-medium sm:w-44 sm:shrink-0">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: ev.group_color || "var(--primary)" }}
        />
        {canOpenDetail ? (
          <Link
            href={`/events/${ev.id}`}
            className="truncate hover:text-primary hover:underline"
          >
            {ev.group_name}
          </Link>
        ) : (
          <span className="truncate">{ev.group_name}</span>
        )}
        {isLabelWide && <LiveLink ev={ev} />}
        <CopyrightBadges ev={ev} />
      </div>

      {/* Status (+ deadline) — pinned right on the phone's top row, and at the far
          right of the single line on a wide screen. Compact colour dot only so the
          variable-width text badge can't crowd the times (push them onto 2 lines). */}
      <div className="order-2 ml-auto flex shrink-0 items-center gap-2 sm:order-3 sm:ml-0">
        {dl && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
              DEADLINE_BADGE[dl.tone]
            )}
          >
            <AlarmClock className="h-3 w-3" /> {dl.label}
          </span>
        )}
        <StatusCell ev={ev} canApproveEvents={canApproveEvents} compact />
      </div>

      {/* The three times staff need. Wraps to its own line under the band on a phone
          (portrait); slots between the band and the status on a wider screen. */}
      <div className="order-3 flex basis-full flex-wrap items-center gap-x-4 gap-y-1 pl-[1.125rem] tabular-nums sm:order-2 sm:basis-0 sm:flex-1 sm:flex-nowrap sm:pl-0">
        <TimeBit label="Stage" className="sm:w-28">
          {fmtRange(ev.stage)}
        </TimeBit>
        <TimeBit label="Booth" className="sm:w-28">
          {fmtRange(ev.booth)}
        </TimeBit>
        <TimeBit label="Photo">
          <PhotoCell ev={ev} />
        </TimeBit>
      </div>
    </div>
  );
}

// Group a flat list of shows by (date + event name) for the export's period views
// (รายวัน/สัปดาห์/เดือน/ปี) — so a festival's name appears ONCE with its bands
// beneath instead of repeating on every row. The input is already date→time
// ordered and a Map keeps first-seen order, so the sub-groups stay sorted.
function groupEventsByShow(events: OverviewEvent[]) {
  const map = new Map<
    string,
    { name: string; date: string | null; events: OverviewEvent[] }
  >();
  for (const ev of events) {
    const key = `${ev.event_date ?? NO_DATE_KEY}__${ev.name}`;
    const g = map.get(key) ?? { name: ev.name, date: ev.event_date, events: [] };
    g.events.push(ev);
    map.set(key, g);
  }
  return Array.from(map.values());
}

// One schedule table for the export JPG, with the "อะไรซ้ำยุบ" column collapse: any
// of งาน / วันที่ that's constant down the whole table is hoisted into the header
// (when not already the label) and its column dropped; วง shows only when bands
// vary. A trailing spacer keeps the kept columns compact on the left. `nested`
// renders a lighter sub-header (used under a period header in รายวัน/เดือน/…);
// `hideDate` drops the date when the period header above already shows it.
function ExportSchedule({
  label,
  color,
  events,
  showBandColumn,
  nested = false,
  hideDate = false,
}: {
  label: string;
  color?: string | null;
  events: OverviewEvent[];
  showBandColumn: boolean;
  nested?: boolean;
  hideDate?: boolean;
}) {
  const first = events[0];
  const dropName = events.every((e) => e.name === first.name);
  const dropDate = events.every((e) => e.event_date === first.event_date);
  const headerName = dropName && first.name !== label ? first.name : null;
  const headerDate =
    !hideDate &&
    dropDate &&
    first.event_date &&
    fmtDateWd(first.event_date) !== label
      ? first.event_date
      : null;
  return (
    <div className="space-y-1.5">
      {label && (
        <h3
          className={cn(
            "flex flex-wrap items-center gap-x-1.5",
            nested
              ? "text-sm font-semibold text-foreground"
              : "text-sm font-bold text-primary"
          )}
        >
          {color !== undefined && (
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: color || "var(--primary)" }}
            />
          )}
          {label}
          {headerName && (
            <span className="font-normal text-foreground">· {headerName}</span>
          )}
          {headerDate && (
            <span className="font-normal tabular-nums text-muted-foreground">
              · {fmtDateWd(headerDate)}
            </span>
          )}
          <span className="font-normal text-muted-foreground">
            · {events.length} {nested ? "วง" : "งาน"}
          </span>
        </h3>
      )}
      <table className="w-full border-collapse text-sm [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {!dropName && <th className="py-1.5 pr-3 font-medium">งาน</th>}
            {showBandColumn && <th className="py-1.5 pr-3 font-medium">วง</th>}
            {!dropDate && <th className="py-1.5 pr-3 font-medium">วันที่</th>}
            <th className="py-1.5 pr-3 font-medium">Stage</th>
            <th className="py-1.5 pr-3 font-medium">Booth</th>
            <th className="py-1.5 pr-3 font-medium">Photo</th>
            {/* Spacer column absorbs the leftover width so the data columns stay
                compact on the left instead of spreading apart. */}
            <th className="w-full" />
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => (
            <tr key={ev.id} className="border-b last:border-0">
              {!dropName && (
                <td className="py-1.5 pr-3 font-medium">{ev.name}</td>
              )}
              {showBandColumn && (
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: ev.group_color || "var(--primary)" }}
                    />
                    {ev.group_name}
                  </span>
                </td>
              )}
              {!dropDate && (
                <td className="py-1.5 pr-3 tabular-nums">
                  {fmtDate(ev.event_date)}
                </td>
              )}
              <td className="py-1.5 pr-3 tabular-nums">{fmtRange(ev.stage)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{fmtRange(ev.booth)}</td>
              <td className="py-1.5 pr-3 tabular-nums">
                {fmtRange({ start: ev.photo, end: ev.photoEnd })}
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewClient({
  events,
  bands,
  staffContacts,
  labelName,
  canApproveEvents,
  isLabelWide,
  canOpenDetail,
}: {
  events: OverviewEvent[];
  bands: OverviewBand[];
  staffContacts: StaffContact[]; // label-wide crew for the export's contact block
  labelName: string; // tenant name, shown as the heading on the exported schedule
  canApproveEvents: boolean;
  isLabelWide: boolean; // show the view-only Live link (overview audience)
  canOpenDetail: boolean; // false for label_staff (overview-only); name is plain text
}) {
  const [mode, setMode] = useState<ViewMode>("band");
  const [bandFilter, setBandFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all"); // "all" or an ISO date
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  // The off-screen export block is rendered ONLY after mount (client-side). It
  // exists solely for the click-triggered JPG export, so it never needs to be in
  // the SSR HTML — keeping it out avoids any server↔client hydration mismatch from
  // that large subtree (e.g. the "generated on <today>" footer), which on mobile
  // Safari could blank the whole page (React #422/#425).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Order the whole schedule by date, then by each show's EARLIEST activity time —
  // staff read a day top-to-bottom in time order, regardless of band.
  const sortedEvents = useMemo(
    () =>
      [...events].sort((a, b) => {
        const da = a.event_date ?? "9999-12-31";
        const db = b.event_date ?? "9999-12-31";
        if (da !== db) return da < db ? -1 : 1;
        return earliestMinutes(a) - earliestMinutes(b);
      }),
    [events]
  );
  const byBand = useMemo(
    () =>
      bandFilter === "all"
        ? sortedEvents
        : sortedEvents.filter((e) => e.group_id === bandFilter),
    [sortedEvents, bandFilter]
  );

  // Dates that actually have a show (within the current band scope), for the
  // "เลือกวัน" picker — so staff can capture a single day instead of every day.
  const availableDates = useMemo(
    () =>
      Array.from(
        new Set(byBand.map((e) => e.event_date).filter((d): d is string => !!d))
      ).sort(),
    [byBand]
  );

  // Apply the date filter on top of the band filter. Guard against a stale date
  // (e.g. after switching band) by falling back to the whole band scope.
  const filtered = useMemo(() => {
    if (dateFilter === "all" || !byBand.some((e) => e.event_date === dateFilter)) {
      return byBand;
    }
    return byBand.filter((e) => e.event_date === dateFilter);
  }, [byBand, dateFilter]);

  const bandFilterLabel =
    bandFilter === "all"
      ? "ทุกวง"
      : bands.find((b) => b.id === bandFilter)?.name ?? "ทุกวง";

  const dateActive = dateFilter !== "all" && availableDates.includes(dateFilter);

  const modeLabel = VIEW_MODES.find((m) => m.value === mode)?.label ?? "";

  // Contact block for the export: label crew first, then a rep for each band that
  // appears in the current (filtered) view — unique, in first-appearance order.
  const bandById = useMemo(() => new Map(bands.map((b) => [b.id, b])), [bands]);
  const exportContacts = useMemo(() => {
    type Row = {
      key: string;
      name: string;
      role: string;
      phone: string;
      color: string | null;
    };
    const crew: Row[] = staffContacts
      .filter((c) => c.name || c.role || c.phone)
      .map((c) => ({
        key: `s-${c.id}`,
        name: c.name,
        role: c.role,
        phone: c.phone,
        color: null,
      }));
    const seen = new Set<string>();
    const reps: Row[] = [];
    for (const ev of filtered) {
      if (seen.has(ev.group_id)) continue;
      seen.add(ev.group_id);
      const b = bandById.get(ev.group_id);
      if (b && (b.contact_name || b.contact_phone)) {
        reps.push({
          key: `b-${b.id}`,
          name: b.contact_name ?? "",
          role: b.name,
          phone: b.contact_phone ?? "",
          color: b.color,
        });
      }
    }
    return { crew, reps };
  }, [staffContacts, filtered, bandById]);

  async function exportImage() {
    const el = exportRef.current;
    if (!el) return;
    setExporting(true);
    try {
      const filename = `schedule-${
        dateActive ? dateFilter : new Date().toISOString().slice(0, 10)
      }.jpg`;
      const how = await captureElementToImage(el, {
        filename,
        shareTitle: `${labelName} · ตารางงาน`,
        width: 820, // wider so the time/date/name columns stay on one line
      });
      toast.success(how === "shared" ? "แชร์รูปตารางแล้ว" : "บันทึกรูปตารางแล้ว");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ — แคปหน้าจอแทนได้", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(false);
    }
  }

  // In "band" mode we list every band (even with 0 events) so rosters show.
  const buckets = useMemo<Bucket[]>(() => {
    if (mode === "band") {
      const shown = bandFilter === "all" ? bands : bands.filter((b) => b.id === bandFilter);
      return shown.map((b) => ({
        key: b.id,
        label: b.name,
        color: b.color,
        events: filtered.filter((e) => e.group_id === b.id),
      }));
    }
    if (mode === "event") {
      // Group by (date + name): one header per show, with its bands listed beneath.
      // A festival where several bands share a name + day collapses to ONE header;
      // a day with two differently-named shows gets two. `filtered` is already in
      // date→time order, and Map keeps first-seen order, so groups stay sorted.
      const map = new Map<string, Bucket>();
      for (const ev of filtered) {
        const key = `${ev.event_date ?? NO_DATE_KEY}__${ev.name}`;
        const b =
          map.get(key) ??
          ({ key, label: ev.name, date: ev.event_date, events: [] } as Bucket);
        b.events.push(ev);
        map.set(key, b);
      }
      return Array.from(map.values());
    }
    const map = new Map<string, Bucket>();
    for (const ev of filtered) {
      const { key, label } = bucketOf(ev, mode);
      const b = map.get(key) ?? { key, label, events: [] };
      b.events.push(ev);
      map.set(key, b);
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [mode, bandFilter, bands, filtered]);

  const showBandColumn = mode !== "band";
  const showRosters = mode === "band";

  return (
    <div className="space-y-6">
      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-1">
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                mode === m.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {availableDates.length > 1 && (
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              title="กรองเฉพาะวันที่เลือก — ถ่ายรูปเฉพาะวันนั้น"
            >
              <option value="all">ทุกวัน</option>
              {availableDates.map((d) => (
                <option key={d} value={d}>
                  {fmtDateWd(d)}
                </option>
              ))}
            </select>
          )}
          {bands.length > 1 && (
            <select
              value={bandFilter}
              onChange={(e) => setBandFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value="all">ทุกวง</option>
              {bands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={exportImage}
            disabled={exporting || filtered.length === 0}
            title="บันทึกตารางงานเป็นรูปไปแจกให้สตาฟ/วง"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImageDown className="h-4 w-4" />
            )}
            บันทึกเป็นรูป
          </Button>
        </div>
      </div>

      {buckets.length === 0 || buckets.every((b) => b.events.length === 0 && !showRosters) ? (
        <p className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          ไม่มีงานในมุมมองนี้
        </p>
      ) : (
        buckets.map((bucket) => {
          const band = showRosters ? bands.find((b) => b.id === bucket.key) : undefined;
          // Hide empty time/event buckets; keep empty band sections (for rosters).
          if (!showRosters && bucket.events.length === 0) return null;
          return (
            <section key={bucket.key} className="space-y-3">
              {(bucket.label || bucket.date) && (
                <div className="flex flex-wrap items-center gap-2">
                  {bucket.color !== undefined && (
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ background: bucket.color || "var(--primary)" }}
                    />
                  )}
                  {bucket.label && (
                    <h2 className="text-lg font-semibold">{bucket.label}</h2>
                  )}
                  {bucket.date && (
                    <span className="rounded-md bg-muted px-2 py-0.5 text-sm font-medium tabular-nums text-muted-foreground">
                      {fmtDateWd(bucket.date)}
                    </span>
                  )}
                  <span className="text-sm text-muted-foreground">
                    · {bucket.events.length} {mode === "event" ? "วง" : "งาน"}
                    {band ? ` · ${band.members.length} คน` : ""}
                  </span>
                </div>
              )}

              {bucket.events.length > 0 &&
                (mode === "event" ? (
                  // Compact report rows — the name + date sit in the header above, so
                  // each row leads with the band and the three times staff need. On a
                  // wide screen the STAGE/BOOTH/PHOTO labels collapse into ONE column
                  // header here (mirrors the row's band-width + column widths so the
                  // times line up under it); on a phone each row keeps its own labels.
                  // Capped width so the compact rows don't stretch edge-to-edge on a
                  // big monitor (they only need ~720px) — the cap is wider than any
                  // phone so mobile is unaffected.
                  <div className="max-w-3xl space-y-1.5">
                    <div className="hidden items-center gap-x-4 px-3 text-xs font-medium uppercase text-muted-foreground sm:flex">
                      <div className="w-44 shrink-0" />
                      <div className="flex flex-1 items-center gap-x-4">
                        <span className="w-28">Stage</span>
                        <span className="w-28">Booth</span>
                        <span>Photo</span>
                      </div>
                    </div>
                    {bucket.events.map((ev) => (
                      <EventScheduleRow
                        key={ev.id}
                        ev={ev}
                        canOpenDetail={canOpenDetail}
                        isLabelWide={isLabelWide}
                        canApproveEvents={canApproveEvents}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    {/* Laptop/desktop (≥xl): full table. A phone in landscape clears
                      md (768) but is still too narrow for 8 columns — times wrap to
                      two lines — so the table is held back to xl; everything below
                      that gets the stacked cards. */}
                  <div className="hidden overflow-x-auto rounded-lg border xl:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2 font-medium">งาน</th>
                          {showBandColumn && <th className="px-3 py-2 font-medium">วง</th>}
                          <th className="px-3 py-2 font-medium">วันที่</th>
                          <th className="px-3 py-2 font-medium tabular-nums">Stage</th>
                          <th className="px-3 py-2 font-medium tabular-nums">Booth</th>
                          <th className="px-3 py-2 font-medium tabular-nums">Photo</th>
                          <th className="px-3 py-2 font-medium">เดดไลน์</th>
                          <th className="px-3 py-2 font-medium">สถานะ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.events.map((ev) => (
                          <tr key={ev.id} className="border-b last:border-0 align-middle">
                            <td className="px-3 py-2">
                              <EventNameCell
                                ev={ev}
                                canOpenDetail={canOpenDetail}
                                isLabelWide={isLabelWide}
                              />
                            </td>
                            {showBandColumn && (
                              <td className="px-3 py-2">
                                <BandTag ev={ev} />
                              </td>
                            )}
                            <td className="px-3 py-2 text-muted-foreground">
                              {fmtDate(ev.event_date)}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">
                              {fmtRange(ev.stage)}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">
                              {fmtRange(ev.booth)}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">
                              <PhotoCell ev={ev} />
                            </td>
                            <td className="px-3 py-2">
                              <DeadlineCell ev={ev} />
                            </td>
                            <td className="px-3 py-2">
                              <StatusCell ev={ev} canApproveEvents={canApproveEvents} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Phone (portrait + landscape) & tablet: stacked cards —
                      everything visible, no side-scroll */}
                  <div className="space-y-2 xl:hidden">
                    {bucket.events.map((ev) => (
                      <EventCard
                        key={ev.id}
                        ev={ev}
                        showBand={showBandColumn}
                        canOpenDetail={canOpenDetail}
                        isLabelWide={isLabelWide}
                        canApproveEvents={canApproveEvents}
                      />
                    ))}
                  </div>
                  </>
                ))}

              {band && band.members.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  {band.members.map((m) => (
                    <span key={m.id} className="rounded-full border px-2 py-0.5 text-xs">
                      {m.mic_number != null && (
                        <span className="mr-1 font-semibold tabular-nums">{m.mic_number}</span>
                      )}
                      {m.label}
                    </span>
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}

      {/* Off-screen clean schedule — rendered only so it can be captured as a JPG
          for distribution. Kept in layout (not display:none) so html-to-image can
          measure it, but CLIPPED inside a 0×0 overflow-hidden box so it never paints
          on-screen. (A plain `-left-[10000px]` offset isn't enough: a wide festival
          schedule can exceed 10000px and its right edge then bleeds back over the
          page, covering the top with its bg-card.) exportRef keeps its full natural
          size for the capture; the helper forces a light palette + fixed width on it.
          Gated on `mounted` so it's client-only — see the note by the state. */}
      {mounted && (
      <div className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden" aria-hidden>
        <div ref={exportRef} className="space-y-4 bg-card p-6 text-foreground">
          <div className="border-b pb-3">
            <h2 className="text-xl font-bold leading-tight">{labelName}</h2>
            <p className="text-sm text-muted-foreground">
              ตารางงาน · {modeLabel} · {bandFilterLabel}
              {dateActive ? ` · ${fmtDateWd(dateFilter)}` : ""} · {filtered.length}{" "}
              งาน
            </p>
          </div>
          {/* Mirror the on-screen grouping (buckets follow the current view mode)
              so "capture" produces whatever arrangement the staff are looking at —
              by band, by day, by week/month/year, or the flat report. */}
          {buckets
            .filter((b) => b.events.length > 0)
            .map((bucket) => {
              // The flat period views (รายวัน/สัปดาห์/เดือน/ปี) sub-group each
              // period's shows by event so a festival's name + date sit ONCE in a
              // sub-header with its bands beneath — not repeated on every row. The
              // date is dropped from the sub-header in รายวัน since the period
              // header already shows it. รายงาน (per-event) and รายวง (per-band)
              // render as a single collapse-aware table — unchanged.
              const isPeriod =
                mode === "day" ||
                mode === "week" ||
                mode === "month" ||
                mode === "year";
              if (isPeriod) {
                return (
                  <div key={bucket.key} className="space-y-2">
                    <h3 className="flex flex-wrap items-center gap-x-1.5 text-sm font-bold text-primary">
                      {bucket.label}
                      <span className="font-normal text-muted-foreground">
                        · {bucket.events.length} งาน
                      </span>
                    </h3>
                    <div className="space-y-2.5 pl-2">
                      {groupEventsByShow(bucket.events).map((g) => (
                        <ExportSchedule
                          key={`${g.date ?? "x"}__${g.name}`}
                          label={g.name}
                          events={g.events}
                          showBandColumn
                          hideDate={mode === "day"}
                          nested
                        />
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <ExportSchedule
                  key={bucket.key}
                  label={bucket.label}
                  color={bucket.color}
                  events={bucket.events}
                  showBandColumn={showBandColumn}
                />
              );
            })}
          {/* Contact block at the BOTTOM — staff read the schedule first, then
              who to call. Crew + band reps in two sections. */}
          {(exportContacts.crew.length > 0 || exportContacts.reps.length > 0) && (
            <div className="space-y-3 border-t pt-3">
              {[
                { key: "crew", title: "ทีมงานค่าย", col2: "หน้าที่", rows: exportContacts.crew },
                { key: "reps", title: "ผู้ติดต่อวง", col2: "วง", rows: exportContacts.reps },
              ]
                .filter((s) => s.rows.length > 0)
                .map((section) => (
                  <div key={section.key} className="space-y-1.5">
                    <h3 className="text-sm font-bold text-primary">{section.title}</h3>
                    <table className="w-full border-collapse text-sm [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">ชื่อ</th>
                          <th className="py-1.5 pr-3 font-medium">{section.col2}</th>
                          <th className="py-1.5 font-medium">เบอร์</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((c) => (
                          <tr key={c.key} className="border-b last:border-0">
                            <td className="py-1.5 pr-3 font-medium">{c.name || "—"}</td>
                            <td className="py-1.5 pr-3">
                              {c.color !== null ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-full"
                                    style={{ background: c.color || "var(--primary)" }}
                                  />
                                  {c.role}
                                </span>
                              ) : (
                                c.role || "—"
                              )}
                            </td>
                            <td className="py-1.5 tabular-nums">{c.phone || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            สร้างจาก CueIQ · {fmtDate(new Date().toISOString().slice(0, 10))}
          </p>
        </div>
      </div>
      )}
    </div>
  );
}
