"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlarmClock, Users, PlayCircle, ImageDown, Loader2 } from "lucide-react";
import { EventStatusActions } from "@/components/overview/event-status-actions";
import { PhotoTimeCell } from "@/components/overview/photo-time-cell";
import { StatusBadge } from "@/components/status-badge";
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

interface Bucket {
  key: string;
  label: string;
  color?: string | null;
  events: OverviewEvent[];
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

  const byBand = useMemo(
    () => (bandFilter === "all" ? events : events.filter((e) => e.group_id === bandFilter)),
    [events, bandFilter]
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
    return [...crew, ...reps];
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
      return [{ key: "all", label: "", events: filtered }];
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
              {bucket.label && (
                <div className="flex items-center gap-2">
                  {bucket.color !== undefined && (
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ background: bucket.color || "var(--primary)" }}
                    />
                  )}
                  <h2 className="text-lg font-semibold">{bucket.label}</h2>
                  <span className="text-sm text-muted-foreground">
                    · {bucket.events.length} งาน
                    {band ? ` · ${band.members.length} คน` : ""}
                  </span>
                </div>
              )}

              {bucket.events.length > 0 && (
                <div className="overflow-x-auto rounded-lg border">
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
                      {bucket.events.map((ev) => {
                        const dl = ev.exempt_from_deadline ? null : deadlineInfo(ev.deadline);
                        return (
                          <tr key={ev.id} className="border-b last:border-0 align-middle">
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                {canOpenDetail ? (
                                  <Link
                                    href={`/events/${ev.id}`}
                                    className="font-medium hover:text-primary hover:underline"
                                  >
                                    {ev.name}
                                  </Link>
                                ) : (
                                  <span className="font-medium">{ev.name}</span>
                                )}
                                {isLabelWide && (
                                  <Link
                                    href={`/events/${ev.id}/live`}
                                    title="เปิด Live (ดูอย่างเดียว)"
                                    className="text-muted-foreground hover:text-primary"
                                  >
                                    <PlayCircle className="h-4 w-4" />
                                  </Link>
                                )}
                                {ev.copyrightRejected > 0 ? (
                                  <Link
                                    href="/library"
                                    title={`${ev.copyrightRejected} เพลงถูกปฏิเสธลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
                                    className="inline-flex items-center gap-0.5 rounded bg-destructive/15 px-1 text-xs font-semibold text-destructive"
                                  >
                                    ⛔ {ev.copyrightRejected}
                                  </Link>
                                ) : ev.copyrightPending > 0 ? (
                                  <Link
                                    href="/library"
                                    title={`${ev.copyrightPending} เพลงรอตรวจลิขสิทธิ์ — ไปจัดการที่คลังเพลง`}
                                    className="inline-flex items-center gap-0.5 rounded bg-amber-400/20 px-1 text-xs font-semibold text-amber-700 dark:text-amber-400"
                                  >
                                    🕒 {ev.copyrightPending}
                                  </Link>
                                ) : null}
                              </div>
                            </td>
                            {showBandColumn && (
                              <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-full"
                                    style={{ background: ev.group_color || "var(--primary)" }}
                                  />
                                  {ev.group_name}
                                </span>
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
                              {ev.canEditPhoto ? (
                                <PhotoTimeCell
                                  eventId={ev.id}
                                  tenantId={ev.tenant_id}
                                  initialItemId={ev.photoItemId}
                                  initialTime={ev.photo}
                                  initialEnd={ev.photoEnd}
                                  nextSortOrder={ev.photoSortOrder}
                                />
                              ) : (
                                fmtRange({ start: ev.photo, end: ev.photoEnd })
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {dl ? (
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
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {canApproveEvents ? (
                                <EventStatusActions
                                  eventId={ev.id}
                                  initialStatus={ev.status}
                                />
                              ) : (
                                <StatusBadge status={ev.status} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
          measure it; pushed far off-screen and hidden from a11y/pointer. The
          capture helper forces a light palette + fixed width on exportRef. */}
      <div className="pointer-events-none fixed -left-[10000px] top-0" aria-hidden>
        <div ref={exportRef} className="space-y-4 bg-card p-6 text-foreground">
          <div className="border-b pb-3">
            <h2 className="text-xl font-bold leading-tight">{labelName}</h2>
            <p className="text-sm text-muted-foreground">
              ตารางงาน · {modeLabel} · {bandFilterLabel}
              {dateActive ? ` · ${fmtDateWd(dateFilter)}` : ""} · {filtered.length}{" "}
              งาน
            </p>
          </div>
          {/* Contact block — label crew + the rep of each band shown that day. */}
          {exportContacts.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-sm font-bold text-primary">ทีมงาน / ติดต่อ</h3>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">ชื่อ</th>
                    <th className="py-1.5 pr-3 font-medium">หน้าที่ / วง</th>
                    <th className="py-1.5 font-medium">เบอร์</th>
                  </tr>
                </thead>
                <tbody>
                  {exportContacts.map((c) => (
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
          )}
          {/* Mirror the on-screen grouping (buckets follow the current view mode)
              so "capture" produces whatever arrangement the staff are looking at —
              by band, by day, by week/month/year, or the flat report. */}
          {buckets
            .filter((b) => b.events.length > 0)
            .map((bucket) => (
              <div key={bucket.key} className="space-y-1.5">
                {bucket.label && (
                  <h3 className="flex items-center gap-1.5 text-sm font-bold text-primary">
                    {bucket.color !== undefined && (
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: bucket.color || "var(--primary)" }}
                      />
                    )}
                    {bucket.label}
                    <span className="font-normal text-muted-foreground">
                      · {bucket.events.length} งาน
                    </span>
                  </h3>
                )}
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">งาน</th>
                      {showBandColumn && (
                        <th className="py-1.5 pr-3 font-medium">วง</th>
                      )}
                      <th className="py-1.5 pr-3 font-medium">วันที่</th>
                      <th className="py-1.5 pr-3 font-medium">Stage</th>
                      <th className="py-1.5 pr-3 font-medium">Booth</th>
                      <th className="py-1.5 font-medium">Photo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bucket.events.map((ev) => (
                      <tr key={ev.id} className="border-b last:border-0">
                        <td className="py-1.5 pr-3 font-medium">{ev.name}</td>
                        {showBandColumn && (
                          <td className="py-1.5 pr-3">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-full"
                                style={{
                                  background: ev.group_color || "var(--primary)",
                                }}
                              />
                              {ev.group_name}
                            </span>
                          </td>
                        )}
                        <td className="py-1.5 pr-3 tabular-nums">
                          {fmtDate(ev.event_date)}
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {fmtRange(ev.stage)}
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {fmtRange(ev.booth)}
                        </td>
                        <td className="py-1.5 tabular-nums">
                          {fmtRange({ start: ev.photo, end: ev.photoEnd })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          <p className="text-[10px] text-muted-foreground">
            สร้างจาก CueIQ · {fmtDate(new Date().toISOString().slice(0, 10))}
          </p>
        </div>
      </div>
    </div>
  );
}
