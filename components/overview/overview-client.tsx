"use client";

import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlarmClock,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  History,
  Hourglass,
  ImageDown,
  ListOrdered,
  Loader2,
  OctagonAlert,
  PlayCircle,
  Radio,
  ShieldAlert,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { EventStatusActions } from "@/components/overview/event-status-actions";
import { PhotoTimeCell } from "@/components/overview/photo-time-cell";
import { StatusBadge } from "@/components/status-badge";
import { TitleSlab } from "@/components/title-slab";
import { Button } from "@/components/ui/button";
import { FIELD } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bandTriplet } from "@/lib/band-triplet";
import { shortClock, deadlineInfo, bkkTodayKey } from "@/lib/time";
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
  stage: TimeRange; // EARLIEST stage slot — everything sorts and filters on this
  booth: TimeRange; // earliest booth shift, same rule
  // A band can play twice and work three booth shifts in one day. These carry the
  // 2nd..Nth slots so the board shows the whole day instead of silently printing
  // only the first one; the row itself stays one-per-event (its identity, sort key
  // and the photo editor all key on that).
  stageMore?: TimeRange[];
  boothMore?: TimeRange[];
  photo: string | null; // start (inline-editable via PhotoTimeCell)
  photoEnd: string | null; // end of the photo window
  // inline-action support
  tenant_id: string;
  canEditPhoto: boolean; // band is self_photo=false AND viewer may set photo time
  photoItemId: string | null; // the photo schedule_item to update (null = none yet)
  photoSortOrder: number; // sort_order to use when inserting a new photo row
  copyrightPending: number; // library songs in this event's setlist awaiting review
  copyrightRejected: number; // library songs in this event's setlist rejected
  incomplete: number; // # of required-but-missing prep items (0 = ready). NOT shown
  // for already-approved events (they passed the gate).
  missingLabels: string[]; // the missing items, for the readiness badge's tooltip
  notes: string | null; // free note shown as a small tag by the name (e.g. the act
  // name for a slot a band plays under a different unit — "G-D!" under HatoBito)
  /** Venue, for the Today hero. Optional: an offline cached row may not carry it. */
  venue?: string | null;
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

// Deadline steps as chips (icon + word, never colour alone). Fill vs tint keeps
// URGENT and SOON apart once both are amber: URGENT is the solid amber plate (its own
// dark ink, 10:1), SOON the amber tint. Overdue is the band-independent alarm plate.
// Tokens only — this file also renders the JPG export (lib/export-surfaces.test.ts).
const DEADLINE_CHIP: Record<string, { cls: string; Icon: LucideIcon }> = {
  overdue: { cls: "chip-alarm", Icon: OctagonAlert },
  urgent: { cls: "bg-warning text-warning-foreground", Icon: Hourglass },
  soon: { cls: "chip-warning", Icon: Hourglass },
  ok: { cls: "chip-neutral", Icon: AlarmClock },
};

/** The band's square — identity by colour AND by the name beside it. */
function BandSquare({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-[1px]", className)}
      style={{ background: `hsl(${bandTriplet(color)})` }}
    />
  );
}

/**
 * "2026-10-04" → { wd: "Sun", day: "04", mon: "Oct" }. Parsed and formatted in UTC so
 * the server and a Bangkok browser print the same day; null for a missing or garbled
 * date (cached rows can lack event_date).
 */
export function dateParts(key: string | null | undefined) {
  if (!key) return null;
  const d = new Date(`${key}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { timeZone: "UTC", ...o });
  return { wd: f({ weekday: "short" }), day: f({ day: "2-digit" }), mon: f({ month: "short" }) };
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"), or null if either is garbled. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** `key` plus `n` days, as "YYYY-MM-DD" (UTC arithmetic: no DST, no zone drift). */
function addDays(key: string, n: number): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  if (isNaN(t)) return key;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

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

/** The first slot plus any repeats, each on its own line (see stageMore/boothMore). */
function fmtSlots(first: TimeRange, more?: TimeRange[]): ReactNode {
  if (!more || more.length === 0) return fmtRange(first);
  return (
    <>
      {[first, ...more].map((r, i) => (
        <div key={i}>{fmtRange(r)}</div>
      ))}
    </>
  );
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
// An event's STAGE start (when the band actually performs) — the time staff sort a
// day by, so every list reads in show order (พี่: เรียงตามเวลาขึ้นเวที). NOT the
// earliest prep activity: an early photo/booth time must not pull a late-stage act
// up the list. Falls back to booth → photo when there's no stage time; a show with
// no time at all sorts last.
function stageMinutes(ev: OverviewEvent): number {
  const t = ev.stage?.start ?? ev.booth?.start ?? ev.photo;
  return t ? toMinutes(t) : Number.POSITIVE_INFINITY;
}
// Each activity sorts by ITS OWN start time so its table reads in that activity's
// order (a late-stage act with an early photo slot must sit early in the PHOTO
// table, not be dragged down by its stage time). Untimed acts sort last.
function photoMinutes(ev: OverviewEvent): number {
  return ev.photo ? toMinutes(ev.photo) : Number.POSITIVE_INFINITY;
}
function boothMinutes(ev: OverviewEvent): number {
  return ev.booth?.start ? toMinutes(ev.booth.start) : Number.POSITIVE_INFINITY;
}
/**
 * Date first, then the given clock: a list that spans several dates (a band's section,
 * a week, the Past fold) must read in calendar order, because each stub leads with its
 * date tile. `newestFirst` flips the dates only (the Past fold) — within one day the
 * clock still runs forward — and an undated show sorts last either way.
 */
function byDateThen(minutes: (ev: OverviewEvent) => number, newestFirst = false) {
  return (a: OverviewEvent, b: OverviewEvent): number => {
    const da = a.event_date ?? "";
    const db = b.event_date ?? "";
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return (da < db ? -1 : 1) * (newestFirst ? -1 : 1);
    }
    return minutes(a) - minutes(b);
  };
}
const hasPhoto = (ev: OverviewEvent) => !!ev.photo;
const hasBooth = (ev: OverviewEvent) => !!(ev.booth && (ev.booth.start || ev.booth.end));

interface Bucket {
  key: string;
  label: string;
  color?: string | null;
  date?: string | null; // report view: the shared event date, shown in the header
  events: OverviewEvent[];
}

// --- The quick filters ("focus"). Each is a count over EVERY row in scope and a
// filter that shows exactly the rows it counted — the approval queue's rule (see the
// note by pendingCount below), extended to the other three tiles. ---
type Focus = "queue" | "week" | "missing" | "rights";

/** What the export subtitle says while a focus is on. */
const FOCUS_EXPORT_LABEL: Record<Focus, string> = {
  queue: "งานที่รออนุมัติ",
  week: "งานใน 7 วันข้างหน้า",
  missing: "งานที่ยังเตรียมไม่ครบ",
  rights: "งานที่มีเพลงติดลิขสิทธิ์",
};
/** The board's section heading while a focus is on (English chrome). */
const FOCUS_TITLE: Record<Focus, string> = {
  queue: "Queue",
  week: "Next 7 Days",
  missing: "Missing Prep",
  rights: "Rights",
};

// Tap area for a small chip-sized link or button: an invisible pseudo-element
// grows the hit box to >= 44 px tall on a phone without growing the chip itself.
const HIT_44 = "relative after:absolute after:-inset-y-2.5 after:inset-x-0 after:content-['']";
// The same for a one-line show / band name (~19-21 px): 13 px each way. Anything after it
// in the row that is itself positioned (the chips above, the status control) stays
// on top of this box, so it never steals their taps.
const HIT_NAME = "relative after:absolute after:-inset-y-[13px] after:inset-x-0 after:content-['']";

// --- Shared cell renderers — the interactive bits (detail link, Live, copyright
// chips, photo-time edit, status actions) live in one place. ---

// View-only Live link (overview audience).
function LiveLink({ ev }: { ev: OverviewEvent }) {
  return (
    <Link
      href={`/events/${ev.id}/live`}
      title="เปิด Live (ดูอย่างเดียว)"
      className={cn("chip chip-neutral en hover:text-foreground", HIT_44)}
    >
      <PlayCircle aria-hidden />
      Live
    </Link>
  );
}

// copyright-status chips that deep-link to the library.
function CopyrightBadges({ ev }: { ev: OverviewEvent }) {
  if (ev.copyrightRejected > 0) {
    return (
      <Link
        href="/library"
        title={`${ev.copyrightRejected} เพลงถูกปฏิเสธลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
        className={cn("chip chip-danger", HIT_44)}
      >
        <ShieldAlert aria-hidden />
        ลิขสิทธิ์ไม่ผ่าน <span className="num text-[13px]">{ev.copyrightRejected}</span>
      </Link>
    );
  }
  if (ev.copyrightPending > 0) {
    return (
      <Link
        href="/library"
        title={`${ev.copyrightPending} เพลงรอตรวจลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
        className={cn("chip chip-warning", HIT_44)}
      >
        <Hourglass aria-hidden />
        รอตรวจลิขสิทธิ์ <span className="num text-[13px]">{ev.copyrightPending}</span>
      </Link>
    );
  }
  return null;
}

// Readiness chip — mirrors CopyrightBadges (only shows when there's something to
// flag). "ยังขาด N" when the event is missing required prep (setlist/mic/
// call-times/…); the tooltip lists exactly what. Hidden once the event is approved
// (it passed the completeness gate) so only in-prep shows get nagged.
function ReadyBadge({ ev }: { ev: OverviewEvent }) {
  if (ev.status === "approved" || ev.incomplete < 1) return null;
  return (
    <Link
      href={`/events/${ev.id}`}
      title={`ยังขาด: ${ev.missingLabels.join(", ")}`}
      className={cn("chip chip-warning", HIT_44)}
    >
      <TriangleAlert aria-hidden />
      ยังขาด <span className="num text-[13px]">{ev.incomplete}</span>
    </Link>
  );
}

// A small muted tag by the name/band carrying SHORT, label-like notes only — the
// intended use is an act/unit name when a band plays a slot under a different unit
// (e.g. "G-D!" on HatoBito's 11:50 slot). Longer notes are descriptions, not labels,
// so they're left out of the schedule rows to avoid clutter.
const ACT_NOTE_MAX = 16;
function ActNote({ ev }: { ev: OverviewEvent }) {
  const note = ev.notes?.trim();
  if (!note || note.length > ACT_NOTE_MAX) return null;
  return (
    <span className="chip chip-neutral shrink-0 font-normal" title={note}>
      {note}
    </span>
  );
}

function BandTag({ ev }: { ev: OverviewEvent }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <BandSquare color={ev.group_color} />
      {ev.group_name}
    </span>
  );
}

// Lets the inline PhotoTimeCell push a saved time back up to OverviewClient (which
// owns the events the export image is rendered from) without threading a callback
// through every row/card/table renderer in between.
const PhotoSaveContext = createContext<
  (
    eventId: string,
    next: { start: string | null; end: string | null; itemId: string | null }
  ) => void
>(() => {});

function PhotoCell({ ev }: { ev: OverviewEvent }) {
  const onPhotoSaved = useContext(PhotoSaveContext);
  return ev.canEditPhoto ? (
    <PhotoTimeCell
      eventId={ev.id}
      tenantId={ev.tenant_id}
      initialItemId={ev.photoItemId}
      initialTime={ev.photo}
      initialEnd={ev.photoEnd}
      nextSortOrder={ev.photoSortOrder}
      onSaved={(next) => onPhotoSaved(ev.id, next)}
    />
  ) : (
    <>{fmtRange({ start: ev.photo, end: ev.photoEnd })}</>
  );
}

function DeadlineCell({ ev }: { ev: OverviewEvent }) {
  const dl = ev.exempt_from_deadline ? null : deadlineInfo(ev.deadline);
  if (!dl) return null;
  const { cls, Icon } = DEADLINE_CHIP[dl.tone] ?? DEADLINE_CHIP.ok;
  return (
    <span className={cn("chip", cls)}>
      <Icon aria-hidden /> {dl.label}
    </span>
  );
}

function StatusCell({
  ev,
  canApproveEvents,
  onStatusChanged,
}: {
  ev: OverviewEvent;
  canApproveEvents: boolean;
  onStatusChanged?: (id: string, next: GroupStatus) => void;
}) {
  return canApproveEvents ? (
    <EventStatusActions
      eventId={ev.id}
      initialStatus={ev.status}
      eventName={ev.name}
      onChanged={(next) => onStatusChanged?.(ev.id, next)}
    />
  ) : (
    <StatusBadge status={ev.status} />
  );
}

// The act's identity for a schedule row: the band (colour square + name) when several
// bands share a bucket, otherwise the event name. `withBadges` adds the live link /
// copyright / readiness / act-note chips — used only in the main Stage list so the
// Photo/Booth tables stay clean. `secondary` is a muted tag (event name and/or date)
// shown only when those vary within the bucket, so a multi-show/multi-date bucket
// (week/month/…) stays unambiguous without a dedicated column.
function ActIdentity({
  ev,
  bandPrimary,
  secondary,
  withBadges = false,
  canOpenDetail,
  isLabelWide,
}: {
  ev: OverviewEvent;
  bandPrimary: boolean;
  secondary: string;
  withBadges?: boolean;
  canOpenDetail: boolean;
  isLabelWide: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {bandPrimary ? (
        canOpenDetail ? (
          <Link
            href={`/events/${ev.id}`}
            className={cn("inline-flex items-center gap-1.5 font-semibold hover:text-primary-ink hover:underline", HIT_NAME)}
          >
            <BandSquare color={ev.group_color} />
            {ev.group_name}
          </Link>
        ) : (
          <span className="font-semibold">
            <BandTag ev={ev} />
          </span>
        )
      ) : canOpenDetail ? (
        <Link
          href={`/events/${ev.id}`}
          className={cn("break-words font-semibold leading-snug hover:text-primary-ink hover:underline", HIT_NAME)}
        >
          {ev.name}
        </Link>
      ) : (
        <span className="break-words font-semibold leading-snug">{ev.name}</span>
      )}
      {secondary && (
        <span className="text-[12.5px] text-muted-foreground">· {secondary}</span>
      )}
      {withBadges && (
        <>
          {isLabelWide && <LiveLink ev={ev} />}
          <CopyrightBadges ev={ev} />
          <ReadyBadge ev={ev} />
          <ActNote ev={ev} />
        </>
      )}
    </div>
  );
}

/** The stub's date block: a solid tile in the band's own colour (`.date-tile`). */
function DateTile({ date, today }: { date: string | null; today: boolean }) {
  const p = dateParts(date);
  return (
    <div className="date-tile py-2">
      {p ? (
        <>
          <span className="eyebrow text-[11px]">{today ? "Today" : p.wd}</span>
          <span className="num mt-[3px] text-[30px] font-extrabold leading-[.92]">{p.day}</span>
          <span className="eyebrow mt-[3px] text-[11px]">{p.mon}</span>
        </>
      ) : (
        <span className="num text-[22px]">—</span>
      )}
    </div>
  );
}

// The Stage list: one stub per act, a stack of slabs on a phone; from sm the same
// rows line up under column heads and read as a table. ONE markup for both — the
// status control holds its own state, so a second copy for the other width would
// have shown a stale chip after an approval made in the first.
const STAGE_COLS = "sm:grid-cols-[minmax(0,1fr)_7.5rem_10.5rem]";

function StageList({
  rows,
  showBandColumn,
  secondaryOf,
  canOpenDetail,
  isLabelWide,
  canApproveEvents,
  onStatusChanged,
  todayKey,
}: {
  rows: OverviewEvent[];
  showBandColumn: boolean;
  secondaryOf: (ev: OverviewEvent) => string;
  canOpenDetail: boolean;
  isLabelWide: boolean;
  canApproveEvents: boolean;
  onStatusChanged?: (id: string, next: GroupStatus) => void;
  todayKey: string;
}) {
  return (
    <div>
      <div aria-hidden className="hidden h-8 items-center sm:flex">
        <span className="w-[72px] shrink-0 text-center font-display text-[12.5px] font-bold uppercase tracking-[.1em] text-muted-foreground [font-synthesis:none]">
          Date
        </span>
        <div
          className={cn(
            "grid flex-1 gap-3 px-3.5 font-display text-[12.5px] font-bold uppercase tracking-[.1em] text-muted-foreground [font-synthesis:none]",
            STAGE_COLS
          )}
        >
          <span>{showBandColumn ? "Band" : "Show"}</span>
          <span>Stage</span>
          <span className="text-right">Status</span>
        </div>
      </div>
      <ul className="stack">
        {rows.map((ev) => {
          const today = ev.event_date === todayKey;
          return (
            <li
              key={ev.id}
              data-today={today || undefined}
              className="stub slab flex items-stretch overflow-hidden"
              style={{ "--band": bandTriplet(ev.group_color) } as CSSProperties}
            >
              <DateTile date={ev.event_date} today={today} />
              <div
                className={cn(
                  "min-w-0 flex-1 px-3.5 py-2.5 text-[15px] sm:grid sm:items-center sm:gap-3",
                  STAGE_COLS,
                  today && "bg-primary/[.06]"
                )}
              >
                <ActIdentity
                  ev={ev}
                  bandPrimary={showBandColumn}
                  secondary={secondaryOf(ev)}
                  withBadges
                  canOpenDetail={canOpenDetail}
                  isLabelWide={isLabelWide}
                />
                {/* A phone line under the name; from sm its two halves become the
                    Stage and Status columns (display: contents). */}
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 sm:contents">
                  <div className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
                    <span className="text-[12px] text-muted-foreground sm:hidden">ขึ้นเวที</span>
                    <div className="num text-[17px] text-foreground">
                      {fmtSlots(ev.stage, ev.stageMore)}
                    </div>
                  </div>
                  <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 sm:ml-0 sm:flex-col sm:items-end">
                    <DeadlineCell ev={ev} />
                    <StatusCell
                      ev={ev}
                      canApproveEvents={canApproveEvents}
                      onStatusChanged={onStatusChanged}
                    />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Row / cell classes for the Photo and Booth tables (see MiniTimeTable). The time
// cell is `relative` so it stacks above the name link's enlarged tap area (HIT_NAME):
// when a long name wraps the time under it on a phone, that box reaches 5 px into
// the photo-time fields and would open the event instead of focusing the field.
const MINI_TR =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border/70 px-3 py-2.5 last:border-0 sm:table-row sm:p-0";
const MINI_TD_NAME = "min-w-0 sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle";
const MINI_TD_TIME =
  "num relative ml-auto whitespace-nowrap text-right text-[15px] sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle";

// A minimal "act → time" table (the Photo and Booth tables). The caller picks and
// sorts the rows; `count` is the number of acts that actually HAVE that time — the
// Photo table appends a labelled "ยังไม่กำหนดเวลา" section whose blank rows are
// deliberately NOT counted (see photoTableRows).
function MiniTimeTable({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[2px] bg-card shadow-edge">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3">
        {/* "· 0" would read as a data claim ("0 acts have a photo call") on a
            stage-only day where this block exists ONLY to offer the to-do section —
            an earlier session removed exactly that "ถ่ายรูป · 0 —" line. */}
        <span className="eyebrow text-muted-foreground">{title}</span>
        {count > 0 && <span className="num text-[14px] text-foreground">{count}</span>}
      </div>
      {/* overflow-y-hidden: the last row's name tap area (HIT_NAME) hangs ~3 px below
          the table, and overflow-x-auto alone computes overflow-y to auto — a 3 px
          vertical scroll, i.e. a scrollbar on every table on a Windows laptop. */}
      <div className="overflow-x-auto overflow-y-hidden">
        {/* A real table from sm. On a phone each row is a flex line instead — the act
            on the left, its time (or the photo editor) beside it, wrapping under the
            name when there is not room — so a long show name is not squeezed into a
            sliver beside two time fields. */}
        <table className="block w-full text-sm sm:table">
          <tbody className="block sm:table-row-group">{children}</tbody>
        </table>
      </div>
    </div>
  );
}

// The three activity sections for one bucket — Stage · Photo · Booth — each sorted
// by date and then by ITS OWN time so a band's photo/booth slot reads in that
// activity's order, not pulled out of place by its stage time (พี่: เวลาถ่ายรูปไม่
// เรียงตามสเตจ → วงโดด). `newestFirst` (the Past fold) puts the latest date on top.
// Stage is the main list (every act + deadline + status); Photo & Booth are minimal
// (act + time) and list only acts that have that time — Photo then appends a
// collapsible to-do section for the acts a viewer may still FILL IN (see
// photoTableRows below). Works the same at every view mode.
function ActivityTables({
  events,
  showBandColumn,
  canOpenDetail,
  isLabelWide,
  canApproveEvents,
  onStatusChanged,
  todayKey,
  newestFirst = false,
}: {
  events: OverviewEvent[];
  showBandColumn: boolean;
  canOpenDetail: boolean;
  isLabelWide: boolean;
  canApproveEvents: boolean;
  onStatusChanged?: (id: string, next: GroupStatus) => void;
  todayKey: string;
  newestFirst?: boolean;
}) {
  const stageRows = useMemo(
    () => [...events].sort(byDateThen(stageMinutes, newestFirst)),
    [events, newestFirst]
  );
  // While a photo editor holds focus, its row is PINNED to the section + sort key it
  // had when focus arrived. PhotoTimeCell commits on blur, and tabbing start→end blurs
  // the START field while focus is still inside the cell — so without this the time
  // that just landed would re-sort the row (or lift it out of the to-do section) from
  // under the staffer mid-entry: React moves a keyed <tr> with insertBefore, which
  // drops focus to <body> and eats the end time being typed. The pin lifts the moment
  // focus really leaves the cell, and the row takes its true place then.
  const [pinned, setPinned] = useState<{
    id: string;
    timed: boolean; // had a photo time when focus arrived…
    at: number; // …and sorted at this minute
  } | null>(null);
  // A pinned act can disappear under us (a data refresh while its editor is focused).
  // React fires no blur on unmount, so drop the pin here — otherwise it would freeze
  // that act's position if the same row comes back.
  useEffect(() => {
    if (pinned && !events.some((ev) => ev.id === pinned.id)) setPinned(null);
  }, [events, pinned]);
  // ถ่ายรูป comes in two parts. The TABLE lists only acts that actually have a photo
  // time, always in time order — so it matches the บันทึกเป็นรูป export exactly and the
  // staffer proofreads on screen what the crew is handed as a JPG (พี่: เวลาไม่เรียง →
  // วงโดด). The acts with NO time yet are the to-do section beneath it, and only for a
  // viewer allowed to set one: label staff are read-only on the event page (and blocked
  // from non-status writes by mig 0037), so without a row here they could never create a
  // band's FIRST photo time — the exact job this inline editor exists for. Keeping them
  // out of the table keeps its headline count honest ("Photo 12" means 12 acts have
  // a call time, not 12 blank inputs on a stage-only day like WARUDO) and keeps them out
  // of the export image, which filters on hasPhoto only.
  const { photoRows, photoTodoRows } = useMemo(() => {
    const timed = (ev: OverviewEvent) =>
      pinned && pinned.id === ev.id ? pinned.timed : hasPhoto(ev);
    const at = (ev: OverviewEvent) =>
      pinned && pinned.id === ev.id ? pinned.at : photoMinutes(ev);
    return {
      photoRows: events.filter((ev) => timed(ev)).sort(byDateThen(at, newestFirst)),
      // Untimed acts keep the bucket's own (date → stage-time) order — there is no
      // photo time to sort them by yet.
      photoTodoRows: events.filter((ev) => ev.canEditPhoto && !timed(ev)),
    };
  }, [events, pinned, newestFirst]);
  // The to-do section opens by default on a day that already uses photo calls, and
  // starts COLLAPSED on a stage-only day, where a wall of blank inputs is pure noise —
  // its one header line keeps it discoverable for the staffer who does need to fill in.
  const [showPhotoTodo, setShowPhotoTodo] = useState(() => photoRows.length > 0);
  const boothRows = useMemo(
    () => events.filter(hasBooth).sort(byDateThen(boothMinutes, newestFirst)),
    [events, newestFirst]
  );
  // Muted secondary tag (event name and/or date) — only when those vary in the
  // bucket, so multi-show / multi-date views stay clear without a separate column.
  const mixNames = showBandColumn && new Set(events.map((e) => e.name)).size > 1;
  const mixDates = new Set(events.map((e) => e.event_date)).size > 1;
  const secondaryOf = (ev: OverviewEvent) => {
    const parts: string[] = [];
    if (mixNames) parts.push(ev.name);
    if (mixDates) parts.push(fmtDate(ev.event_date));
    return parts.join(" · ");
  };

  // Pin/unpin the row a photo editor is being used in (see `pinned` above).
  const pinPhotoRow = (ev: OverviewEvent) =>
    setPinned((p) =>
      // Focus moving WITHIN the same cell (start → end) must keep the ORIGINAL
      // snapshot — re-reading it here would adopt the time just saved and move the
      // row anyway, which is the whole thing the pin exists to prevent.
      p && p.id === ev.id
        ? p
        : { id: ev.id, timed: hasPhoto(ev), at: photoMinutes(ev) }
    );
  const unpinPhotoRow = (e: React.FocusEvent<HTMLTableCellElement>) => {
    // relatedTarget = where focus is heading; null (clicked dead space) or anything
    // outside this cell means the staffer is done with the row.
    if (!e.currentTarget.contains(e.relatedTarget)) setPinned(null);
  };

  // One ถ่ายรูป row — used by BOTH the timed table and the to-do section, which share
  // a single <tbody> (one keyed list) on purpose: when a row gains a time React then
  // MOVES the existing <tr> instead of unmounting it. A remount would throw away
  // PhotoTimeCell's live state mid-entry — the end time typed but not yet flushed, and
  // the write it defers while the start write is still in flight — i.e. a save that
  // silently never happens.
  const renderPhotoRow = (ev: OverviewEvent) => (
    <tr key={ev.id} className={MINI_TR}>
      <td className={MINI_TD_NAME}>
        <ActIdentity
          ev={ev}
          bandPrimary={showBandColumn}
          secondary={secondaryOf(ev)}
          canOpenDetail={canOpenDetail}
          isLabelWide={isLabelWide}
        />
      </td>
      <td
        className={MINI_TD_TIME}
        onFocus={ev.canEditPhoto ? () => pinPhotoRow(ev) : undefined}
        onBlur={ev.canEditPhoto ? unpinPhotoRow : undefined}
      >
        <PhotoCell ev={ev} />
      </td>
    </tr>
  );
  const photoTableRows = [
    ...photoRows.map((ev) => renderPhotoRow(ev)),
    ...(photoTodoRows.length > 0
      ? [
          <tr key="__photo-todo" className="flex border-b border-border/70 last:border-0 sm:table-row">
            <td colSpan={2} className="w-full p-0 sm:table-cell">
              <button
                type="button"
                onClick={() => setShowPhotoTodo((v) => !v)}
                aria-expanded={showPhotoTodo}
                className="relative flex min-h-11 w-full items-center gap-1.5 bg-muted px-3 py-1.5 text-left text-[12.5px] font-semibold text-muted-foreground transition-colors duration-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-9"
              >
                {showPhotoTodo ? (
                  <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                )}
                ยังไม่กำหนดเวลาถ่ายรูป · {photoTodoRows.length}
                {!showPhotoTodo && (
                  <span className="font-normal">— กดเพื่อกำหนดเวลา</span>
                )}
              </button>
            </td>
          </tr>,
        ]
      : []),
    ...(showPhotoTodo ? photoTodoRows.map((ev) => renderPhotoRow(ev)) : []),
  ];

  return (
    <div className="space-y-3">
      {/* Stage — the main list: every act, plus deadline + status + chips */}
      <StageList
        rows={stageRows}
        showBandColumn={showBandColumn}
        secondaryOf={secondaryOf}
        canOpenDetail={canOpenDetail}
        isLabelWide={isLabelWide}
        canApproveEvents={canApproveEvents}
        onStatusChanged={onStatusChanged}
        todayKey={todayKey}
      />

      {/* Photo + Booth — minimal, each in its own time order; side-by-side on wide
          screens (like the organiser's Portrait/Stage sheets), hidden when empty.
          Photo also shows up when it has no times but the viewer may add some —
          that block is then just its one collapsed to-do line. */}
      {(photoTableRows.length > 0 || boothRows.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          {photoTableRows.length > 0 && (
            <MiniTimeTable title="Photo" count={photoRows.length}>
              {photoTableRows}
            </MiniTimeTable>
          )}
          {boothRows.length > 0 && (
            <MiniTimeTable title="Booth" count={boothRows.length}>
              {boothRows.map((ev) => (
                <tr key={ev.id} className={MINI_TR}>
                  <td className={MINI_TD_NAME}>
                    <ActIdentity
                      ev={ev}
                      bandPrimary={showBandColumn}
                      secondary={secondaryOf(ev)}
                      canOpenDetail={canOpenDetail}
                      isLabelWide={isLabelWide}
                    />
                  </td>
                  <td className={MINI_TD_TIME}>
                    {fmtSlots(ev.booth, ev.boothMore)}
                  </td>
                </tr>
              ))}
            </MiniTimeTable>
          )}
        </div>
      )}
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

// Staff entry-point to the festival-wide running order, shown in a date/festival
// header on Overview (approvers only). The running order is per festival (name +
// date), so a header may carry one (รายงาน view) or a few (a busy day) — each gets
// a "Running Order" (build) link and, once it has rows, a "คุมคิว (Live)" link to
// run it as Master. `?from=overview` makes those pages return here. Bands don't see
// this — they watch their own slot's status on their event page.
function FestivalRunControls({
  bucketEvents,
  runOrderSet,
}: {
  bucketEvents: OverviewEvent[];
  runOrderSet: Set<string>;
}) {
  const groups = groupEventsByShow(bucketEvents);
  if (groups.length === 0) return null;
  const multi = groups.length > 1;
  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
      {groups.map((g) => {
        const repId = g.events[0]?.id;
        if (!repId) return null;
        const key = `${g.name}__${g.date ?? ""}`;
        const hasOrder = runOrderSet.has(key);
        return (
          <div key={key} className="flex flex-wrap items-center gap-1.5">
            {multi && (
              <span className="max-w-[10rem] truncate text-[12.5px] text-muted-foreground">
                {g.name}:
              </span>
            )}
            {hasOrder && (
              <Button size="sm" asChild className="h-11 sm:h-9">
                <Link href={`/events/${repId}/run-order/live?from=overview`}>
                  <Radio aria-hidden /> คุมคิว (Live)
                </Link>
              </Button>
            )}
            <Button size="sm" variant="secondary" asChild className="h-11 sm:h-9">
              <Link href={`/events/${repId}/run-order?from=overview`}>
                <ListOrdered aria-hidden /> Running Order
              </Link>
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// One activity column in the export image: a small "act → time" table sorted by the
// caller. `secondary(ev)` appends the event name / date as a muted tag when they vary
// within the group (so a band-spanning or multi-date group stays unambiguous).
// EXPORT SURFACE: flat, upright, tokens only (no dark-mode variant, no .lit / .cut / slab).
function ExportActivityCol({
  title,
  rows,
  showBandColumn,
  secondary,
  timeOf,
}: {
  title: string;
  rows: OverviewEvent[];
  showBandColumn: boolean;
  secondary: (ev: OverviewEvent) => string;
  // ReactNode, not string: a band with more than one stage/booth slot renders each
  // on its own line inside the cell (see fmtSlots).
  timeOf: (ev: OverviewEvent) => ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">
        {title} · {rows.length}
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        /* Name + time packed to the LEFT (a trailing spacer eats the slack) so the
           time sits right next to the band — not flung to the far right edge of a
           full-width table, which made the eye travel across an empty gap. The time
           still shares a column, so values stay vertically aligned row-to-row. */
        <table className="w-full border-collapse text-sm [&_td]:whitespace-nowrap">
          <tbody>
            {rows.map((ev) => (
              <tr key={ev.id} className="border-b last:border-0">
                <td className="py-1.5 pr-4 font-medium">
                  {showBandColumn ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: ev.group_color || "var(--primary)" }}
                      />
                      {ev.group_name}
                    </span>
                  ) : (
                    ev.name
                  )}
                  {secondary(ev) && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      {secondary(ev)}
                    </span>
                  )}
                </td>
                <td className="py-1.5 tabular-nums">{timeOf(ev)}</td>
                <td className="w-full" />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// One festival/band block in the export image, split into the three activity tables
// (Stage / Photo / Booth) — each in its own time order, mirroring the on-screen view
// and the organiser's separate Portrait/Stage sheets. The "อะไรซ้ำยุบ" column
// collapse: any of งาน / วันที่ that's constant down the whole block is hoisted into
// the header (when not already the label); `nested` renders a lighter sub-header
// (used under a period header in รายวัน/เดือน/…); `hideDate` drops the date when the
// period header already shows it.
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

  const stageRows = [...events].sort(byDateThen(stageMinutes));
  const photoRows = events.filter(hasPhoto).sort(byDateThen(photoMinutes));
  const boothRows = events.filter(hasBooth).sort(byDateThen(boothMinutes));

  // Disambiguate rows when the group mixes shows/dates: append the differing bits.
  const secondary = (ev: OverviewEvent) => {
    const parts: string[] = [];
    if (showBandColumn && !dropName) parts.push(ev.name);
    if (!dropDate) parts.push(fmtDate(ev.event_date));
    return parts.length ? ` · ${parts.join(" · ")}` : "";
  };

  return (
    <div className="space-y-2">
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
      <ExportActivityCol
        title="ขึ้นแสดง (Stage)"
        rows={stageRows}
        showBandColumn={showBandColumn}
        secondary={secondary}
        timeOf={(ev) => fmtSlots(ev.stage, ev.stageMore)}
      />
      {/* Photo + Booth side by side; each hidden when empty so a stage-only show
          (e.g. WARUDO has no photo) doesn't print an empty "ถ่ายรูป · 0 —" table.
          Mirrors the on-screen ActivityTables. */}
      {(photoRows.length > 0 || boothRows.length > 0) && (
        <div className="grid grid-cols-2 gap-4">
          {photoRows.length > 0 && (
            <ExportActivityCol
              title="ถ่ายรูป (Photo)"
              rows={photoRows}
              showBandColumn={showBandColumn}
              secondary={secondary}
              timeOf={(ev) => fmtRange({ start: ev.photo, end: ev.photoEnd })}
            />
          )}
          {boothRows.length > 0 && (
            <ExportActivityCol
              title="บูธ (Booth)"
              rows={boothRows}
              showBandColumn={showBandColumn}
              secondary={secondary}
              timeOf={(ev) => fmtSlots(ev.booth, ev.boothMore)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Group events into the board's sections for the current view mode. */
function bucketize(
  list: OverviewEvent[],
  mode: ViewMode,
  bands: OverviewBand[],
  bandFilter: string,
  opts: { keepEmptyBands: boolean; newestFirst?: boolean }
): Bucket[] {
  if (mode === "band") {
    // In "band" mode every band is listed (even with 0 events) so rosters show.
    const shown = bandFilter === "all" ? bands : bands.filter((b) => b.id === bandFilter);
    return shown
      .map((b) => ({
        key: b.id,
        label: b.name,
        color: b.color,
        events: list.filter((e) => e.group_id === b.id),
      }))
      .filter((b) => opts.keepEmptyBands || b.events.length > 0);
  }
  if (mode === "event") {
    // Group by (date + name): one header per show, with its bands listed beneath.
    // A festival where several bands share a name + day collapses to ONE header;
    // a day with two differently-named shows gets two. `list` is already in
    // date→time order, and Map keeps first-seen order, so groups stay sorted.
    const map = new Map<string, Bucket>();
    for (const ev of list) {
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
  for (const ev of list) {
    const { key, label } = bucketOf(ev, mode);
    const b = map.get(key) ?? { key, label, events: [] };
    b.events.push(ev);
    map.set(key, b);
  }
  return Array.from(map.values()).sort((a, b) =>
    opts.newestFirst ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)
  );
}

/** One quick-filter tile: a count over every show in scope that is also its filter. */
function KpiTile({
  icon: Icon,
  iconClass,
  count,
  label,
  active,
  onToggle,
  title,
}: {
  icon: LucideIcon;
  iconClass: string;
  count: number;
  label: string;
  active: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      // Nothing to show is not a filter: a tile reading 0 stays as the all-clear,
      // but tapping it would only empty the board.
      disabled={count === 0}
      onClick={onToggle}
      title={title}
      className={cn(
        "flex min-h-[68px] min-w-0 flex-col items-stretch justify-between gap-1 rounded-[2px] px-3 py-2.5 text-left transition-colors duration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
        active
          ? "bg-foreground text-background"
          : "bg-card shadow-edge enabled:hover:bg-muted"
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={cn("num text-[26px] leading-none", count === 0 && !active && "text-faint")}>
          {count}
        </span>
        <Icon aria-hidden className={cn("h-[18px] w-[18px] shrink-0", !active && iconClass)} />
      </span>
      <span className={cn("truncate text-[12.5px] leading-tight", !active && "text-muted-foreground")}>
        {label}
      </span>
    </button>
  );
}

/**
 * The screen's one lit hero: what is on TODAY across the label (or this band), else
 * how far off the next show is. The approval queue — the nag approvers came for —
 * and the JPG export are its actions.
 */
function TodayHero({
  todayKey,
  events,
  canOpenDetail,
  actions,
}: {
  todayKey: string;
  events: OverviewEvent[];
  canOpenDetail: boolean;
  actions: ReactNode;
}) {
  const p = dateParts(todayKey);
  const todays = events
    .filter((e) => e.event_date === todayKey)
    .sort((a, b) => stageMinutes(a) - stageMinutes(b));
  const next = todays.length
    ? null
    : events
        .filter((e) => !!e.event_date && e.event_date > todayKey)
        .sort((a, b) =>
          a.event_date === b.event_date
            ? stageMinutes(a) - stageMinutes(b)
            : (a.event_date ?? "") < (b.event_date ?? "")
              ? -1
              : 1
        )[0];
  const inDays = next?.event_date ? daysBetween(todayKey, next.event_date) : null;

  return (
    <section className="lit cut sweep p-4 [--cut:20px]" aria-label="วันนี้">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow key">
          Today{p ? ` · ${p.wd} ${p.day} ${p.mon}` : ""}
        </span>
        {todays.length > 0 ? (
          <span className="chip chip-primary">
            <CalendarDays aria-hidden />
            <span className="num text-[14px]">{todays.length}</span> โชว์วันนี้
          </span>
        ) : (
          <span className="chip chip-neutral">
            <CalendarDays aria-hidden />
            ไม่มีโชว์วันนี้
          </span>
        )}
      </div>

      {todays.length > 0 ? (
        <ul className="stack mt-3">
          {todays.map((ev) => (
            <li
              key={ev.id}
              className="relative flex min-h-[52px] items-center gap-3 rounded-[2px] bg-muted px-3 py-2"
              style={{ boxShadow: `inset 4px 0 0 hsl(${bandTriplet(ev.group_color)})` }}
            >
              <span className="num w-[3.25rem] shrink-0 text-[22px] leading-none">
                {shortClock(ev.stage?.start) || "—"}
              </span>
              <div className="min-w-0 flex-1">
                {canOpenDetail ? (
                  <Link
                    href={`/events/${ev.id}`}
                    // ::after covers the whole row: the row is the tap target.
                    className="block truncate text-[14px] font-semibold after:absolute after:inset-0 after:content-[''] hover:text-primary-ink hover:underline"
                  >
                    {ev.name}
                  </Link>
                ) : (
                  <span className="block truncate text-[14px] font-semibold">{ev.name}</span>
                )}
                <span className="block truncate text-[12px] text-muted-foreground">
                  {[ev.group_name, ev.venue].filter(Boolean).join(" · ")}
                </span>
              </div>
              <StatusBadge status={ev.status} className="shrink-0" />
            </li>
          ))}
        </ul>
      ) : next ? (
        <>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            งานถัดไป ·{" "}
            {inDays === 1 ? (
              <span className="text-foreground">พรุ่งนี้</span>
            ) : (
              <>
                อีก <span className="num text-[17px] text-foreground">{inDays ?? "—"}</span> วัน
              </>
            )}{" "}
            · {next.group_name}
          </p>
          <TitleSlab name={next.name} size={26} className="mt-1" />
        </>
      ) : (
        <p className="mt-2.5 text-[13px] text-muted-foreground">ยังไม่มีงานที่จะถึงในตาราง</p>
      )}

      {actions && <div className="mt-3.5 flex flex-wrap gap-2">{actions}</div>}
    </section>
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
  runOrderFestivals = [],
  todayKey: todayProp,
}: {
  events: OverviewEvent[];
  bands: OverviewBand[];
  staffContacts: StaffContact[]; // label-wide crew for the export's contact block
  labelName: string; // tenant name, shown as the heading on the exported schedule
  canApproveEvents: boolean;
  isLabelWide: boolean; // show the view-only Live link (overview audience)
  canOpenDetail: boolean; // false for label_staff (overview-only); name is plain text
  runOrderFestivals?: string[]; // "name__date" keys that already have a running order
  /** Bangkok "YYYY-MM-DD". The server passes its own so the HTML it renders and the
   *  client that hydrates it agree on which shows are past; defaults to now. */
  todayKey?: string;
}) {
  const todayKey = todayProp ?? bkkTodayKey();
  // Fast lookup of which festivals (name + date) already have a running order, so
  // the header can offer "คุมคิว (Live)" only when there's something to run.
  const runOrderSet = useMemo(
    () => new Set(runOrderFestivals),
    [runOrderFestivals]
  );
  const [mode, setMode] = useState<ViewMode>("band");
  const [bandFilter, setBandFilter] = useState<string>("all");
  // "show me only what is waiting for me" — and its three siblings. See the queue
  // note and the filter below.
  const [focus, setFocus] = useState<Focus | null>(null);
  const [dateFilter, setDateFilter] = useState<string>("all"); // "all" or an ISO date
  // Shows that already happened sit folded under the upcoming board.
  const [pastOpen, setPastOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  // The off-screen export block is rendered ONLY after mount (client-side). It
  // exists solely for the click-triggered JPG export, so it never needs to be in
  // the SSR HTML — keeping it out avoids any server↔client hydration mismatch from
  // that large subtree (e.g. the "generated on <today>" footer), which on mobile
  // Safari could blank the whole page (React #422/#425).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Photo-time edits made in the inline cells, kept here so BOTH the on-screen rows
  // and the off-screen export image reflect them without a reload — the export reads
  // ev.photo/ev.photoEnd directly, not through the editor's own state.
  const [photoEdits, setPhotoEdits] = useState<
    Record<string, { start: string | null; end: string | null; itemId: string | null }>
  >({});
  const handlePhotoSaved = useCallback(
    (
      eventId: string,
      next: { start: string | null; end: string | null; itemId: string | null }
    ) => setPhotoEdits((prev) => ({ ...prev, [eventId]: next })),
    []
  );
  // Approvals made from the board, kept here for the same reason photoEdits are:
  // EventStatusActions holds its own badge state and the server rows do not change
  // under us, so without this the "รออนุมัติ N" chip below would keep counting a
  // show that was approved thirty seconds ago. Only writes that actually landed
  // reach this (see EventStatusActions' onChanged).
  const [statusEdits, setStatusEdits] = useState<Record<string, GroupStatus>>({});
  const handleStatusChanged = useCallback((id: string, next: GroupStatus) => {
    setStatusEdits((prev) => ({ ...prev, [id]: next }));
  }, []);

  const mergedEvents = useMemo(
    () =>
      events.map((e) => {
        const edit = photoEdits[e.id];
        const status = statusEdits[e.id] ?? e.status;
        const withStatus = status === e.status ? e : { ...e, status };
        return edit
          ? { ...withStatus, photo: edit.start, photoEnd: edit.end, photoItemId: edit.itemId }
          : withStatus;
      }),
    [events, photoEdits, statusEdits]
  );

  // Order the whole schedule by date, then by each show's STAGE time — staff read a
  // day top-to-bottom in performance order, regardless of band.
  const sortedEvents = useMemo(
    () =>
      [...mergedEvents].sort((a, b) => {
        const da = a.event_date ?? "9999-12-31";
        const db = b.event_date ?? "9999-12-31";
        if (da !== db) return da < db ? -1 : 1;
        return stageMinutes(a) - stageMinutes(b);
      }),
    [mergedEvents]
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

  // A show is past once its date is behind today (Bangkok). An undated show is not
  // past — it simply has no date yet, and sorts last among the upcoming.
  const isPast = useCallback(
    (e: OverviewEvent) => !!e.event_date && e.event_date < todayKey,
    [todayKey]
  );

  // ── THE APPROVAL QUEUE, AS A PLACE YOU CAN LOOK ──────────────────────────
  // On 2026-08-31 "Gorya seitan sai" was found still at pending_review, submitted
  // 15 July for a 19 July show. It had been sitting on THIS BOARD the whole time,
  // visible and one tap from approval — inside a fifty-row list with nothing that
  // said how many were waiting. The daily cron now reminds approvers about future
  // shows, but a reminder is a push: it cannot help a submission whose date has
  // already passed, and it cannot be looked up when someone wonders. This chip is
  // the pull half, and it is deliberately the cheap kind — a count and a filter
  // over rows already in hand, no query, no notification, no new channel.
  //
  // Counted over EVERY row in scope, never over `filtered`: a queue a band filter
  // can hide is the same bug one step along. The same holds for the three tiles
  // beside it. The queue alone also reaches into the past (and so is never folded):
  // a past-dated submission is exactly the one the cron cannot reach.
  const weekEnd = addDays(todayKey, 6);
  const focusTest = useMemo<Record<Focus, (e: OverviewEvent) => boolean>>(
    () => ({
      queue: (e) => e.status === "pending_review",
      week: (e) => !!e.event_date && e.event_date >= todayKey && e.event_date <= weekEnd,
      missing: (e) => !isPast(e) && e.status !== "approved" && e.incomplete > 0,
      rights: (e) => !isPast(e) && e.copyrightPending + e.copyrightRejected > 0,
    }),
    [todayKey, weekEnd, isPast]
  );
  const counts = useMemo(() => {
    const c: Record<Focus, number> = { queue: 0, week: 0, missing: 0, rights: 0 };
    let rejected = 0;
    for (const e of mergedEvents) {
      for (const f of Object.keys(c) as Focus[]) if (focusTest[f](e)) c[f]++;
      if (focusTest.rights(e) && e.copyrightRejected > 0) rejected++;
    }
    return { ...c, rightsRejected: rejected };
  }, [mergedEvents, focusTest]);
  const pendingCount = counts.queue;
  // Derived, not stored, so approving the last one cannot strand the viewer on an
  // empty board with the chip already gone and no way to switch it off. Same for
  // every tile: a focus whose count fell to 0 simply stops filtering.
  const activeFocus: Focus | null = focus && counts[focus] > 0 ? focus : null;
  const queueActive = activeFocus === "queue";

  const toggleFocus = (f: Focus) => {
    // Switching a focus ON clears the band and date filters. `filtered` already
    // ignores them, but the BUCKETS are built from `bandFilter` (in รายวง mode the
    // board renders one section per selected band), so without this a band filter
    // still hid rows the tile was counting — the very bug the count exists to
    // prevent, one level down. Clearing them also makes the two selects SAY
    // "ทุกวง / ทุกวัน", so the controls agree with what is on screen instead of
    // contradicting it.
    const on = activeFocus !== f;
    if (on) {
      setBandFilter("all");
      setDateFilter("all");
    }
    setFocus(on ? f : null);
  };

  const dateActive = dateFilter !== "all" && availableDates.includes(dateFilter);

  // Apply the date filter on top of the band filter. Guard against a stale date
  // (e.g. after switching band) by falling back to the whole band scope.
  const filtered = useMemo(() => {
    // A focus ignores the band and date filters on purpose: it must always show
    // exactly what its count promises, or it is lying about the size of the queue.
    if (activeFocus) return sortedEvents.filter(focusTest[activeFocus]);
    if (!dateActive) return byBand;
    return byBand.filter((e) => e.event_date === dateFilter);
  }, [byBand, dateFilter, dateActive, activeFocus, focusTest, sortedEvents]);

  // Today and what is coming first; the past folds away underneath. Not while a focus
  // or a picked day is on — those show exactly what was asked for, past or not.
  const folding = !activeFocus && !dateActive;
  const upcoming = useMemo(
    () => (folding ? filtered.filter((e) => !isPast(e)) : filtered),
    [filtered, folding, isPast]
  );
  const past = useMemo(
    () =>
      folding
        ? filtered
            .filter(isPast)
            // Most recent first: the show that just happened is the one looked up.
            .sort(byDateThen(stageMinutes, true))
        : [],
    [filtered, folding, isPast]
  );

  const showBandColumn = mode !== "band";
  const showRosters = mode === "band";

  const boardBuckets = useMemo(
    () =>
      bucketize(upcoming, mode, bands, bandFilter, {
        // Empty band sections stay for their rosters — not under a focus, which is
        // a list of things to act on.
        keepEmptyBands: showRosters && !activeFocus,
      }),
    [upcoming, mode, bands, bandFilter, showRosters, activeFocus]
  );
  const pastBuckets = useMemo(
    () => bucketize(past, mode, bands, bandFilter, { keepEmptyBands: false, newestFirst: true }),
    [past, mode, bands, bandFilter]
  );

  // The JPG is what the staffer is looking at: the upcoming board, plus the past only
  // while its fold is open (or whatever a focus / picked day shows) — in date order,
  // one section per band / show / period, as before the fold existed.
  const exportEvents = pastOpen ? filtered : upcoming;
  const exportBuckets = useMemo(
    () => bucketize(exportEvents, mode, bands, bandFilter, { keepEmptyBands: false }),
    [exportEvents, mode, bands, bandFilter]
  );

  const bandFilterLabel =
    bandFilter === "all"
      ? "ทุกวง"
      : bands.find((b) => b.id === bandFilter)?.name ?? "ทุกวง";

  const modeLabel = VIEW_MODES.find((m) => m.value === mode)?.label ?? "";

  // Contact block for the export: label crew first, then a rep for each band that
  // appears in the current (exported) view — unique, in first-appearance order.
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
    for (const ev of exportEvents) {
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
  }, [staffContacts, exportEvents, bandById]);

  async function exportImage() {
    const el = exportRef.current;
    if (!el) return;
    setExporting(true);
    try {
      const filename = `schedule-${
        dateActive ? dateFilter : bkkTodayKey()
      }.jpg`;
      const how = await captureElementToImage(el, {
        filename,
        shareTitle: `${labelName} · ตารางงาน`,
        width: 820, // wider so the time/date/name columns stay on one line
      });
      if (how === "cancelled") return; // user dismissed the share sheet — nothing was saved
      toast.success(how === "shared" ? "แชร์รูปตารางแล้ว" : "บันทึกรูปตารางแล้ว");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ — แคปหน้าจอแทนได้", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(false);
    }
  }

  // One board section (a band, a show, a day …): its header, the three activity
  // sections, and — in รายวง — the band's roster. `newestFirst` for the Past fold.
  const renderBucket = (bucket: Bucket, rosters: boolean, newestFirst = false) => {
    const band = rosters ? bands.find((b) => b.id === bucket.key) : undefined;
    return (
      <section key={bucket.key} className="space-y-3">
        {(bucket.label || bucket.date) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {bucket.color !== undefined && (
              <BandSquare color={bucket.color} className="h-3.5 w-3.5 rounded-[2px]" />
            )}
            {bucket.label && (
              <h3 className="disp min-w-0 break-words text-[20px] leading-tight">
                {bucket.label}
              </h3>
            )}
            {bucket.date && (
              <span className="chip chip-neutral">
                <CalendarDays aria-hidden />
                <span className="num text-[13px]">{fmtDateWd(bucket.date)}</span>
              </span>
            )}
            <span className="text-[13px] text-muted-foreground">
              · <span className="num text-[14px] text-foreground">{bucket.events.length}</span>{" "}
              {mode === "event" ? "วง" : "งาน"}
              {band ? (
                <>
                  {" "}
                  · <span className="num text-[14px] text-foreground">{band.members.length}</span> คน
                </>
              ) : null}
            </span>
            {canApproveEvents && mode !== "band" && (
              <FestivalRunControls
                bucketEvents={bucket.events}
                runOrderSet={runOrderSet}
              />
            )}
          </div>
        )}

        {bucket.events.length > 0 && (
          // Three time-ordered sections (Stage / Photo / Booth) — same at every
          // view mode. The bucket header already carries the name/date, so the
          // rows lead with the act and its time.
          <ActivityTables
            events={bucket.events}
            showBandColumn={showBandColumn}
            canOpenDetail={canOpenDetail}
            isLabelWide={isLabelWide}
            canApproveEvents={canApproveEvents}
            onStatusChanged={handleStatusChanged}
            todayKey={todayKey}
            newestFirst={newestFirst}
          />
        )}

        {band && band.members.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Users className="h-4 w-4 text-muted-foreground" aria-label="สมาชิก" />
            {band.members.map((m) => (
              <span key={m.id} className="chip chip-neutral text-foreground">
                {m.mic_number != null && (
                  <span className="num text-[13px] text-muted-foreground">{m.mic_number}</span>
                )}
                {m.label}
              </span>
            ))}
          </div>
        )}
      </section>
    );
  };

  const boardHasRows = boardBuckets.some((b) => b.events.length > 0);
  const boardTitle = activeFocus
    ? FOCUS_TITLE[activeFocus]
    : dateActive
      ? "Day"
      : "Upcoming";

  return (
    <PhotoSaveContext.Provider value={handlePhotoSaved}>
    <div className="space-y-4">
      <TodayHero
        todayKey={todayKey}
        events={mergedEvents}
        canOpenDetail={canOpenDetail}
        actions={
          <>
            {/* Only approvers see it, and only when something is actually waiting —
                a chip reading "รออนุมัติ 0" is furniture. */}
            {canApproveEvents && pendingCount > 0 && (
              <Button
                type="button"
                data-testid="approval-queue-chip"
                aria-pressed={queueActive}
                onClick={() => toggleFocus("queue")}
                title={
                  queueActive
                    ? "กลับไปดูตารางทั้งหมด"
                    : "ดูเฉพาะงานที่รออนุมัติ (รวมงานที่วันงานผ่านไปแล้ว)"
                }
                className="h-12 flex-1 px-3 aria-pressed:bg-foreground aria-pressed:text-background sm:flex-none sm:px-6"
              >
                <Hourglass aria-hidden />
                รออนุมัติ <span className="num text-[19px]">{pendingCount}</span>
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={exportImage}
              disabled={exporting || exportEvents.length === 0}
              title="บันทึกตารางงานเป็นรูปไปแจกให้สตาฟ/วง"
              className="h-12 flex-1 px-3 sm:flex-none sm:px-6"
            >
              {exporting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <ImageDown aria-hidden />
              )}
              บันทึกเป็นรูป
            </Button>
          </>
        }
      />

      <div role="group" aria-label="ตัวกรองด่วน" className="grid grid-cols-3 gap-[2px]">
        <KpiTile
          icon={CalendarDays}
          iconClass="text-primary-ink"
          count={counts.week}
          label="งานใน 7 วัน"
          active={activeFocus === "week"}
          onToggle={() => toggleFocus("week")}
          title="ดูเฉพาะงานตั้งแต่วันนี้ถึงอีก 7 วัน"
        />
        <KpiTile
          icon={TriangleAlert}
          iconClass="text-warning-ink"
          count={counts.missing}
          label="ยังเตรียมไม่ครบ"
          active={activeFocus === "missing"}
          onToggle={() => toggleFocus("missing")}
          title="ดูเฉพาะงานที่จะถึงซึ่งยังขาดข้อมูลที่ต้องมี"
        />
        <KpiTile
          icon={ShieldAlert}
          iconClass={counts.rightsRejected > 0 ? "text-destructive" : "text-warning-ink"}
          count={counts.rights}
          label="ติดลิขสิทธิ์"
          active={activeFocus === "rights"}
          onToggle={() => toggleFocus("rights")}
          title="ดูเฉพาะงานที่จะถึงซึ่งมีเพลงรอตรวจหรือไม่ผ่านลิขสิทธิ์"
        />
      </div>

      {/* View + filters */}
      <div className="space-y-2">
        <div
          role="group"
          aria-label="มุมมอง"
          className="seg grid-flow-row grid-cols-3 sm:grid-flow-col sm:grid-cols-none [&>*]:h-11 sm:[&>*]:h-[38px]"
        >
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
              className={cn(
                "transition-colors duration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                mode === m.value ? "on" : "hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        {(availableDates.length > 1 || bands.length > 1) && (
          <div className="flex flex-wrap gap-2">
            {availableDates.length > 1 && (
              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                aria-label="เลือกวัน"
                className={cn(FIELD, "h-11 min-w-0 flex-1 px-3 text-base sm:h-10 sm:flex-none sm:text-sm")}
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
                aria-label="เลือกวง"
                className={cn(FIELD, "h-11 min-w-0 flex-1 px-3 text-base sm:h-10 sm:flex-none sm:text-sm")}
              >
                <option value="all">ทุกวง</option>
                {bands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 pt-2">
        <h2 className="h2">{boardTitle}</h2>
        <span className="pb-0.5 text-[13px] text-muted-foreground">
          <span className="num text-[16px] text-foreground">{upcoming.length}</span> งาน
        </span>
      </div>

      {!boardHasRows && !showRosters ? (
        <p className="rounded-[2px] border border-dashed border-border py-12 text-center text-[14px] text-muted-foreground">
          {past.length > 0 ? "ไม่มีงานที่จะถึงในมุมมองนี้ — งานที่ผ่านไปแล้วอยู่ด้านล่าง" : "ไม่มีงานในมุมมองนี้"}
        </p>
      ) : boardBuckets.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border py-12 text-center text-[14px] text-muted-foreground">
          ไม่มีงานในมุมมองนี้
        </p>
      ) : (
        <div className="space-y-6">{boardBuckets.map((b) => renderBucket(b, showRosters))}</div>
      )}

      {/* The past, folded. A <details> keeps the rows in the document while shut —
          they are still part of the board, one tap away — and the export follows
          whether it is open. */}
      {past.length > 0 && (
        <details
          open={pastOpen}
          onToggle={(e) => setPastOpen(e.currentTarget.open)}
          className="group pt-2"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[2px] bg-card px-3 py-2 shadow-edge transition-colors duration-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <History className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
            <span className="h2 text-[22px]">Past</span>
            <span className="text-[13px] text-muted-foreground">
              <span className="num text-[15px] text-foreground">{past.length}</span> งานที่ผ่านไปแล้ว
            </span>
            <ChevronDown
              aria-hidden
              className="ml-auto h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-2 group-open:rotate-180"
            />
          </summary>
          <div className="mt-4 space-y-6">{pastBuckets.map((b) => renderBucket(b, false, true))}</div>
        </details>
      )}

      {/* Off-screen clean schedule — rendered only so it can be captured as a JPG
          for distribution. Kept in layout (not display:none) so html-to-image can
          measure it, but CLIPPED inside a 0×0 overflow-hidden box so it never paints
          on-screen. (A plain `-left-[10000px]` offset isn't enough: a wide festival
          schedule can exceed 10000px and its right edge then bleeds back over the
          page, covering the top with its bg-card.) exportRef keeps its full natural
          size for the capture; the helper forces a light palette + fixed width on it.
          Flat and upright, tokens only (spec §D) — none of the board's stage dress.
          Gated on `mounted` so it's client-only — see the note by the state. */}
      {mounted && (
      <div className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden" aria-hidden>
        <div ref={exportRef} className="space-y-4 bg-card p-6 text-foreground">
          <div className="border-b pb-3">
            <h2 className="text-xl font-bold leading-tight">{labelName}</h2>
            <p className="text-sm text-muted-foreground">
              {activeFocus
                ? FOCUS_EXPORT_LABEL[activeFocus]
                : `ตารางงาน · ${modeLabel} · ${bandFilterLabel}`}
              {!activeFocus && dateActive ? ` · ${fmtDateWd(dateFilter)}` : ""} ·{" "}
              {exportEvents.length} งาน
            </p>
          </div>
          {/* Mirror the on-screen grouping (buckets follow the current view mode)
              so "capture" produces whatever arrangement the staff are looking at —
              by band, by day, by week/month/year, or the flat report. */}
          {exportBuckets.map((bucket) => {
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
                          <th className="py-2 pr-4 font-medium">ชื่อ</th>
                          <th className="py-2 pr-4 font-medium">{section.col2}</th>
                          <th className="py-2 font-medium">เบอร์</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((c) => (
                          <tr key={c.key} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{c.name || "—"}</td>
                            <td className="py-2 pr-4">
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
                            <td className="py-2 tabular-nums">{c.phone || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            สร้างจาก CueIQ · {fmtDate(bkkTodayKey())}
          </p>
        </div>
      </div>
      )}
    </div>
    </PhotoSaveContext.Provider>
  );
}
