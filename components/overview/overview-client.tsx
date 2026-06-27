"use client";

import {
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
  Users,
  PlayCircle,
  ImageDown,
  Loader2,
  Radio,
  ListOrdered,
} from "lucide-react";
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
  incomplete: number; // # of required-but-missing prep items (0 = ready). NOT shown
  // for already-approved events (they passed the gate).
  missingLabels: string[]; // the missing items, for the readiness badge's tooltip
  notes: string | null; // free note shown as a small tag by the name (e.g. the act
  // name for a slot a band plays under a different unit — "G-D!" under HatoBito)
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
const hasPhoto = (ev: OverviewEvent) => !!ev.photo;
const hasBooth = (ev: OverviewEvent) => !!(ev.booth && (ev.booth.start || ev.booth.end));

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

// Readiness badge — mirrors CopyrightBadges (only shows when there's something to
// flag). "ยังขาด N" amber tag when the event is missing required prep (setlist/mic/
// call-times/…); the tooltip lists exactly what. Hidden once the event is approved
// (it passed the completeness gate) so only in-prep shows get nagged.
function ReadyBadge({ ev }: { ev: OverviewEvent }) {
  if (ev.status === "approved" || ev.incomplete < 1) return null;
  return (
    <Link
      href={`/events/${ev.id}`}
      title={`ยังขาด: ${ev.missingLabels.join(", ")}`}
      className="inline-flex items-center gap-0.5 rounded bg-amber-400/20 px-1 text-xs font-semibold text-amber-700 dark:text-amber-400"
    >
      ⚠ ขาด {ev.incomplete}
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
    <span
      className="shrink-0 rounded-full border px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
      title={note}
    >
      {note}
    </span>
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

// The act's identity for a schedule row: the band (color dot + name) when several
// bands share a bucket, otherwise the event name. `withBadges` adds the live link /
// copyright / readiness / act-note chips — used only in the main Stage table so the
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
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {bandPrimary ? (
        canOpenDetail ? (
          <Link
            href={`/events/${ev.id}`}
            className="inline-flex items-center gap-1.5 font-medium hover:text-primary hover:underline"
          >
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: ev.group_color || "var(--primary)" }}
            />
            {ev.group_name}
          </Link>
        ) : (
          <BandTag ev={ev} />
        )
      ) : canOpenDetail ? (
        <Link
          href={`/events/${ev.id}`}
          className="break-words font-medium hover:text-primary hover:underline"
        >
          {ev.name}
        </Link>
      ) : (
        <span className="break-words font-medium">{ev.name}</span>
      )}
      {secondary && (
        <span className="text-xs text-muted-foreground">· {secondary}</span>
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

// A minimal "act → time" table (the Photo and Booth tables). Sorted by its own
// activity time by the caller; lists only the acts that have that time.
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
    <div className="overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
        {title} · {count}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

// The three activity tables for one bucket — ขึ้นแสดง (Stage) · ถ่ายรูป (Photo) ·
// บูธ (Booth) — each sorted by ITS OWN time so a band's photo/booth slot reads in
// that activity's order, not pulled out of place by its stage time (พี่: เวลาถ่ายรูป
// ไม่เรียงตามสเตจ → วงโดด). Stage is the main table (every act + deadline + status);
// Photo & Booth are minimal (act + time) and list only acts that have that time.
// Replaces the old single 3-time table/cards — works the same at every view mode.
function ActivityTables({
  events,
  showBandColumn,
  canOpenDetail,
  isLabelWide,
  canApproveEvents,
}: {
  events: OverviewEvent[];
  showBandColumn: boolean;
  canOpenDetail: boolean;
  isLabelWide: boolean;
  canApproveEvents: boolean;
}) {
  const stageRows = useMemo(
    () => [...events].sort((a, b) => stageMinutes(a) - stageMinutes(b)),
    [events]
  );
  const photoRows = useMemo(
    () => events.filter(hasPhoto).sort((a, b) => photoMinutes(a) - photoMinutes(b)),
    [events]
  );
  const boothRows = useMemo(
    () => events.filter(hasBooth).sort((a, b) => boothMinutes(a) - boothMinutes(b)),
    [events]
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

  return (
    <div className="space-y-4">
      {/* Stage — the main table: every act, plus deadline + status + badges */}
      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 font-medium">{showBandColumn ? "วง" : "งาน"}</th>
                <th className="px-3 py-2 font-medium tabular-nums">ขึ้นแสดง</th>
                <th className="px-3 py-2 text-right font-medium">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {stageRows.map((ev) => (
                <tr key={ev.id} className="border-b align-middle last:border-0">
                  <td className="px-3 py-2">
                    <ActIdentity
                      ev={ev}
                      bandPrimary={showBandColumn}
                      secondary={secondaryOf(ev)}
                      withBadges
                      canOpenDetail={canOpenDetail}
                      isLabelWide={isLabelWide}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                    {fmtRange(ev.stage)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <DeadlineCell ev={ev} />
                      <StatusCell ev={ev} canApproveEvents={canApproveEvents} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Photo + Booth — minimal, each in its own time order; side-by-side on wide
          screens (like the organiser's Portrait/Stage sheets), hidden when empty. */}
      {(photoRows.length > 0 || boothRows.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {photoRows.length > 0 && (
            <MiniTimeTable title="ถ่ายรูป" count={photoRows.length}>
              {photoRows.map((ev) => (
                <tr key={ev.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <ActIdentity
                      ev={ev}
                      bandPrimary={showBandColumn}
                      secondary={secondaryOf(ev)}
                      canOpenDetail={canOpenDetail}
                      isLabelWide={isLabelWide}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                    <PhotoCell ev={ev} />
                  </td>
                </tr>
              ))}
            </MiniTimeTable>
          )}
          {boothRows.length > 0 && (
            <MiniTimeTable title="บูธ" count={boothRows.length}>
              {boothRows.map((ev) => (
                <tr key={ev.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <ActIdentity
                      ev={ev}
                      bandPrimary={showBandColumn}
                      secondary={secondaryOf(ev)}
                      canOpenDetail={canOpenDetail}
                      isLabelWide={isLabelWide}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtRange(ev.booth)}
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
    <div className="ml-auto flex flex-wrap items-center gap-1.5">
      {groups.map((g) => {
        const repId = g.events[0]?.id;
        if (!repId) return null;
        const key = `${g.name}__${g.date ?? ""}`;
        const hasOrder = runOrderSet.has(key);
        return (
          <div key={key} className="flex items-center gap-1">
            {multi && (
              <span className="max-w-[8rem] truncate text-xs text-muted-foreground">
                {g.name}:
              </span>
            )}
            {hasOrder && (
              <Button size="sm" variant="default" asChild className="h-7">
                <Link href={`/events/${repId}/run-order/live?from=overview`}>
                  <Radio className="h-3.5 w-3.5" /> คุมคิว (Live)
                </Link>
              </Button>
            )}
            <Button size="sm" variant="outline" asChild className="h-7">
              <Link href={`/events/${repId}/run-order?from=overview`}>
                <ListOrdered className="h-3.5 w-3.5" /> Running Order
              </Link>
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// One schedule table for the export JPG, with the "อะไรซ้ำยุบ" column collapse: any
// of งาน / วันที่ that's constant down the whole table is hoisted into the header
// (when not already the label) and its column dropped; วง shows only when bands
// vary. The kept columns spread evenly across the full width (no spacer) so the
// image reads airy and matches the contact tables below — not packed against the
// left edge. `nested` renders a lighter sub-header (used under a period header in
// รายวัน/เดือน/…); `hideDate` drops the date when the period header already shows it.
// One activity column in the export image: a small "act → time" table sorted by the
// caller. `secondary(ev)` appends the event name / date as a muted tag when they vary
// within the group (so a band-spanning or multi-date group stays unambiguous).
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
  timeOf: (ev: OverviewEvent) => string;
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">
        {title} · {rows.length}
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <table className="w-full border-collapse text-sm [&_td]:whitespace-nowrap">
          <tbody>
            {rows.map((ev) => (
              <tr key={ev.id} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-medium">
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
                <td className="py-1.5 text-right tabular-nums">{timeOf(ev)}</td>
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
// and the organiser's separate Portrait/Stage sheets.
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

  const stageRows = [...events].sort((a, b) => stageMinutes(a) - stageMinutes(b));
  const photoRows = events.filter(hasPhoto).sort((a, b) => photoMinutes(a) - photoMinutes(b));
  const boothRows = events.filter(hasBooth).sort((a, b) => boothMinutes(a) - boothMinutes(b));

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
        timeOf={(ev) => fmtRange(ev.stage)}
      />
      <div className="grid grid-cols-2 gap-4">
        <ExportActivityCol
          title="ถ่ายรูป (Photo)"
          rows={photoRows}
          showBandColumn={showBandColumn}
          secondary={secondary}
          timeOf={(ev) => fmtRange({ start: ev.photo, end: ev.photoEnd })}
        />
        <ExportActivityCol
          title="บูธ (Booth)"
          rows={boothRows}
          showBandColumn={showBandColumn}
          secondary={secondary}
          timeOf={(ev) => fmtRange(ev.booth)}
        />
      </div>
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
  runOrderFestivals = [],
}: {
  events: OverviewEvent[];
  bands: OverviewBand[];
  staffContacts: StaffContact[]; // label-wide crew for the export's contact block
  labelName: string; // tenant name, shown as the heading on the exported schedule
  canApproveEvents: boolean;
  isLabelWide: boolean; // show the view-only Live link (overview audience)
  canOpenDetail: boolean; // false for label_staff (overview-only); name is plain text
  runOrderFestivals?: string[]; // "name__date" keys that already have a running order
}) {
  // Fast lookup of which festivals (name + date) already have a running order, so
  // the header can offer "คุมคิว (Live)" only when there's something to run.
  const runOrderSet = useMemo(
    () => new Set(runOrderFestivals),
    [runOrderFestivals]
  );
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
  const mergedEvents = useMemo(
    () =>
      events.map((e) => {
        const edit = photoEdits[e.id];
        return edit
          ? { ...e, photo: edit.start, photoEnd: edit.end, photoItemId: edit.itemId }
          : e;
      }),
    [events, photoEdits]
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
    <PhotoSaveContext.Provider value={handlePhotoSaved}>
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
                  {canApproveEvents && mode !== "band" && (
                    <FestivalRunControls
                      bucketEvents={bucket.events}
                      runOrderSet={runOrderSet}
                    />
                  )}
                </div>
              )}

              {bucket.events.length > 0 && (
                // Three time-ordered tables (Stage / Photo / Booth) — same at every
                // view mode. The bucket header already carries the name/date, so the
                // tables lead with the act and its time.
                <ActivityTables
                  events={bucket.events}
                  showBandColumn={showBandColumn}
                  canOpenDetail={canOpenDetail}
                  isLabelWide={isLabelWide}
                  canApproveEvents={canApproveEvents}
                />
              )}

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
            สร้างจาก CueIQ · {fmtDate(new Date().toISOString().slice(0, 10))}
          </p>
        </div>
      </div>
      )}
    </div>
    </PhotoSaveContext.Provider>
  );
}
