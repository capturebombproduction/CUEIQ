"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Radio,
  ImageDown,
  CalendarDays,
  ExternalLink,
  Loader2,
  Clock,
  AlarmClock,
  CheckCircle2,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PrintButton } from "@/components/print-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  computeSetlistTimes,
  formatDuration,
  formatClockOfDay,
  parseClockToSeconds,
  shortClock,
} from "@/lib/time";
import { mapsEmbedUrl } from "@/lib/venues";
import { cn } from "@/lib/utils";
import {
  SCHEDULE_KIND_LABELS,
  SETLIST_KIND_SHORT,
  type EventRow,
  type Group,
  type Member,
  type ScheduleItem,
  type ScheduleKind,
  type SetlistItem,
} from "@/lib/types";
import { captureElementToImage } from "@/lib/export-image";
import { type CompletenessResult } from "@/lib/completeness";
import { EventRunStatusCard } from "@/components/event/event-run-status";
import { type RunSeqLive } from "@/components/event/event-live-caller";

function fmtDate(date: string | null): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function Line({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="min-w-[120px] shrink-0 font-medium text-muted-foreground">
        {label}
      </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-bold uppercase tracking-wide text-primary">
        {title}
      </h3>
      {children}
    </section>
  );
}

// Short row labels for the timeline. SCHEDULE_KIND_LABELS is the fallback (kind is
// free text in the DB, so an unknown value still gets a name) but its entries carry
// the English+Thai pair for a form dropdown — far too long once the time column
// leads each line.
const KIND_SHORT: Partial<Record<ScheduleKind, string>> = {
  on_location: "ถึงสถานที่",
  dressing_room: "ห้องแต่งตัว",
  sound_check: "Sound Check",
  photo: "ถ่ายรูป",
  costume: "เปลี่ยนชุด",
  stb: "STB",
  stage: "ขึ้นเวที",
  booth: "บูธ",
};

/** One line of the day's timetable: what happens, when. */
type TimelineEntry = {
  key: string;
  /** raw "HH:MM:SS" for ordering; null rows (label only, no clock yet) sort last */
  start: string | null;
  sortOrder: number;
  time: string | null;
  label: string;
  detail: string | null;
  note: string | null;
};

// A single time-ordered list, NOT one block per kind. Grouping by kind put a band's
// second STB directly under its first — "เอา stanby มารวมกัน ไม่ได้เรียงเป็นซีเควนซ์"
// (Ipond, 2026-07-30) — so on a two-show day nobody could tell which standby belonged
// to which stage slot. Read down the clock and the day plays back in order.
function TimelineLine({ e }: { e: TimelineEntry }) {
  const what = [e.label, e.detail].filter(Boolean).join(" · ");
  return (
    <div className="text-sm">
      <div className="flex gap-3">
        <span className="min-w-[104px] shrink-0 whitespace-nowrap font-medium tabular-nums">
          {e.time || "—"}
        </span>
        <span className="min-w-0 font-medium">{what}</span>
      </div>
      {e.note && (
        <p className="ml-[116px] mt-0.5 text-xs font-normal text-muted-foreground">
          📝 {e.note}
        </p>
      )}
    </div>
  );
}

export function EventSummary({
  event,
  schedule,
  setlist,
  members,
  showMic,
  onNavigate,
  lineup = [],
  completeness,
  editable = false,
  tenantId,
  runSeq = [],
}: {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  members: Member[];
  showMic: boolean;
  onNavigate: (view: string) => void;
  lineup?: string[];
  completeness?: CompletenessResult;
  editable?: boolean;
  tenantId: string;
  /** This festival's running order — drives the read-only live status card. */
  runSeq?: RunSeqLive[];
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  const showStartSec = parseClockToSeconds(event.show_start_time);
  const hardOutSec = parseClockToSeconds(event.hard_out_time);
  const hasClock = showStartSec != null;
  const timing = computeSetlistTimes(setlist, showStartSec ?? 0, hardOutSec);

  // EVERY row of a kind, earliest first — a band can have two stage slots, three
  // booth shifts and two costume changes in one day, and this sheet is what they
  // run the day off. Picking one row per kind (what this did) silently dropped the
  // rest: an event with a 14:00 and a 17:40 stage printed only the 14:00.
  // Rows with no start time sort last (they carry a label/notes but no clock).
  const schedAll = (kind: ScheduleKind) =>
    schedule
      .filter((s) => s.kind === kind)
      .sort((a, b) =>
        (a.start_time ?? "￿").localeCompare(b.start_time ?? "￿")
      );
  const range = (s?: ScheduleItem) =>
    s && (s.start_time || s.end_time)
      ? `${shortClock(s.start_time) || "—"}${
          s.end_time ? `–${shortClock(s.end_time)}` : ""
        }`
      : null;

  const showWindow =
    event.show_start_time || event.hard_out_time
      ? `${shortClock(event.show_start_time) || "—"}–${
          shortClock(event.hard_out_time) || "—"
        }`
      : null;

  const stageRows = schedAll("stage");
  const stageCovered = stageRows.some((s) => range(s) === showWindow);

  // The whole day as one list, earliest first. Every schedule row appears — including
  // kinds nothing hard-codes (today "other", which is both the DB default and what
  // the "แถวว่าง" button creates) — so a row can never fall off the sheet again.
  const timeline: TimelineEntry[] = [
    ...schedule.map((s) => {
      const own = s.label?.trim() || null;
      const loc = s.location?.trim() || null;
      const short = KIND_SHORT[s.kind];
      // An "other" row has no meaningful kind name, so it titles itself with its own
      // label (same rule as the share page) and doesn't repeat it in the detail.
      const named = short ?? null;
      const label = named ?? own ?? SCHEDULE_KIND_LABELS[s.kind] ?? s.kind;
      // People often retype the kind into the label ("ถ่ายรูป", "Stage", "Booth"),
      // which printed as "ถ่ายรูป · ถ่ายรูป". Drop it when it just restates the kind
      // — in Thai (the heading) or in English (SCHEDULE_KIND_LABELS' leading name).
      // SCHEDULE_KIND_LABELS entries are dropdown text — "Stage (ขึ้นเวที)",
      // "Booth / High-touch / แฟนไซน์" — so take the leading name off each.
      const aliases = [short, SCHEDULE_KIND_LABELS[s.kind]?.split(/ \(| \/ /)[0]]
        .filter(Boolean)
        .map((x) => x!.toLowerCase());
      const ownIsKind = !!own && aliases.includes(own.toLowerCase());
      const detail =
        [named && !ownIsKind ? own : null, loc].filter(Boolean).join(" · ") || null;
      return {
        key: s.id,
        start: s.start_time,
        sortOrder: s.sort_order ?? 0,
        time: range(s),
        label,
        detail,
        note: s.notes?.trim() || null,
      };
    }),
    // events.show_start_time/hard_out_time is a SEPARATE field that drives the setlist
    // timing below. A stage row usually mirrors it, so it only earns a line of its own
    // when the schedule does not already cover that window — otherwise the same slot
    // would print twice.
    ...(showWindow && !stageCovered
      ? [
          {
            key: "__show_window",
            start: event.show_start_time,
            sortOrder: -1,
            time: showWindow,
            label: KIND_SHORT.stage!,
            detail: null,
            note: null,
          },
        ]
      : []),
  ]
    // A row with nothing on it at all would print as a bare "—".
    .filter((e) => e.time || e.detail || e.note || e.label)
    .sort(
      (a, b) =>
        (a.start ?? "￿").localeCompare(b.start ?? "￿") || a.sortOrder - b.sortOrder
    );

  const mapQuery = event.venue || event.name;

  async function exportJpg() {
    const el = captureRef.current;
    if (!el) return;
    setExporting(true);
    setIsCapturing(true); // swap iframe → static map
    await new Promise((r) => setTimeout(r, 120)); // wait for re-render
    try {
      const filename = `${event.name.replace(/[^\w\-]+/g, "_") || "summary"}.jpg`;
      const how = await captureElementToImage(el, {
        filename,
        shareTitle: event.name,
      });
      toast.success(how === "shared" ? "แชร์รูปสรุปแล้ว" : "บันทึกรูปสรุปแล้ว");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ — แคปหน้าจอแทนได้", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setIsCapturing(false);
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action bar — not included in the exported image / print */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={`/events/${event.id}/live`}>
            <Radio className="h-4 w-4" /> เข้า Live Mode
          </Link>
        </Button>
        <Button variant="outline" onClick={exportJpg} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageDown className="h-4 w-4" />
          )}
          บันทึกเป็นรูป (JPG)
        </Button>
        <PrintButton />
        <p className="self-center text-xs text-muted-foreground">
          หน้านี้เป็นสรุปอย่างเดียว — แก้ข้อมูลที่แท็บ/ปุ่มด้านล่าง
        </p>
      </div>

      {/* Live status of this band's slot in the festival running order (read-only).
          Staff drive the show from Overview → the live board; the band watches here. */}
      {runSeq.length > 0 && (
        <div className="no-print">
          <EventRunStatusCard
            rows={runSeq}
            selfEventId={event.id}
            tenantId={tenantId}
            eventName={event.name}
            eventDate={event.event_date}
          />
        </div>
      )}

      {/* Completeness gate — editors only, while the event is editable
          (draft / pending_review / rejected). Approved is locked. */}
      {editable &&
        completeness &&
        !event.is_template &&
        (event.status === "draft" ||
          event.status === "pending_review" ||
          event.status === "rejected") && (
          <div className="no-print">
            {completeness.complete ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                <span className="font-medium">
                  ข้อมูลครบแล้ว
                  {event.status === "pending_review"
                    ? " — ส่งขออนุมัติแล้ว (รออนุมัติ 🟠)"
                    : event.status === "rejected"
                    ? " — กด “ส่งขออนุมัติอีกครั้ง” ด้านบน"
                    : ""}
                </span>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
                <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-5 w-5 shrink-0" />
                  ยังขาดข้อมูลก่อนส่งขออนุมัติ ({completeness.missing.length})
                </div>
                <ul className="ml-7 mt-1.5 list-disc space-y-0.5 text-muted-foreground">
                  {completeness.missing.map((m) => (
                    <li key={m.key}>{m.label}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

      {/* Captured summary — also the printable run sheet */}
      <div
        ref={captureRef}
        className="print-flat space-y-5 rounded-lg border bg-card p-6 text-foreground"
      >
        {/* Heading */}
        <div className="space-y-1 border-b pb-3">
          <h2 className="text-xl font-bold leading-tight">{event.name}</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" /> {fmtDate(event.event_date)}
            </span>
            {event.group?.name && (
              <span className="font-medium text-foreground">
                {event.group.name}
              </span>
            )}
          </div>
        </div>

        {/* Event note — the free text an Ar types on the event form ("ห้ามใช้ backing
            track เพลง 3"). It used to render on no in-app surface at all: only on a
            public share link that may never have been generated, so the instruction
            reached nobody. First thing on the sheet, and it prints/exports with it. */}
        {event.notes?.trim() && (
          <Section title="Notes">
            <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-sm">
              {event.notes}
            </p>
          </Section>
        )}

        {/* Location */}
        <Section title="Location">
          <Line label="Venue" value={event.venue} />
          {event.map_url && !isCapturing && (
            <div className="flex gap-2 text-sm">
              <span className="min-w-[120px] shrink-0 font-medium text-muted-foreground">
                Google Map
              </span>
              <a
                href={event.map_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all font-medium text-primary underline"
              >
                View Map <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          )}
          {mapQuery && !isCapturing && (
            <div className="no-print overflow-hidden rounded-md border">
              <iframe
                title="map"
                src={mapsEmbedUrl(mapQuery)}
                className="h-48 w-full"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          )}
        </Section>

        {/* The day, in order */}
        <Section title="Schedule">
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">ยังไม่มีกำหนดการ</p>
          ) : (
            timeline.map((e) => <TimelineLine key={e.key} e={e} />)
          )}
          <Line label="ธีมชุด" value={event.costume_theme} />
        </Section>

        {/* Setlist — detailed table */}
        <Section title={`Setlist & Show Flow (${setlist.length})`}>
          {!isCapturing && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pb-1 text-sm">
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Total Duration{" "}
                <b className="tabular-nums">{formatDuration(timing.totalSeconds)}</b>
              </span>
              {hardOutSec != null &&
                (timing.isOver ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlarmClock className="h-3.5 w-3.5" /> เกิน Hard Out{" "}
                    {formatDuration(timing.overBy)}
                  </Badge>
                ) : (
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Remaining{" "}
                    {formatDuration(Math.max(0, hardOutSec - timing.endSec))}
                  </Badge>
                ))}
            </div>
          )}

          {setlist.length === 0 ? (
            <p className="text-sm text-muted-foreground">ยังไม่มีรายการ</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8 py-2 text-right text-xs">#</TableHead>
                    <TableHead className={`w-12 py-2 text-xs ${isCapturing ? "hidden" : "hidden sm:table-cell"}`}>Type</TableHead>
                    {hasClock && (
                      <TableHead className={`w-24 py-2 text-xs ${isCapturing ? "hidden" : "hidden sm:table-cell"}`}>Start – End</TableHead>
                    )}
                    <TableHead className="py-2 text-xs">Title / Topic</TableHead>
                    <TableHead className="hidden w-16 py-2 text-right text-xs sm:table-cell">Duration</TableHead>
                    <TableHead className="hidden w-20 py-2 text-right text-xs sm:table-cell">Running Time</TableHead>
                    <TableHead className={`w-40 py-2 text-xs ${isCapturing ? "hidden" : "hidden lg:table-cell"}`}>Mic Assignment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {setlist.map((it, idx) => {
                    const t = timing.rows[idx];
                    const slots = it.mic_slots ?? [];
                    return (
                      <TableRow key={it.id} className={t?.overHardOut ? "bg-destructive/5" : ""}>
                        {/* # */}
                        <TableCell className="py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                          {idx + 1}
                        </TableCell>
                        {/* Type — hidden on portrait / during export */}
                        <TableCell className={`py-1.5 text-[10px] font-bold text-muted-foreground ${isCapturing ? "hidden" : "hidden sm:table-cell"}`}>
                          {SETLIST_KIND_SHORT[it.kind]}
                        </TableCell>
                        {/* Start–End — hidden on portrait / during export */}
                        {hasClock && (
                          <TableCell className={`py-1.5 tabular-nums text-xs text-muted-foreground ${isCapturing ? "hidden" : "hidden sm:table-cell"}`}>
                            {formatClockOfDay(t.startSec)}–{formatClockOfDay(t.endSec)}
                          </TableCell>
                        )}
                        {/* Title — time shown inline on portrait / during export */}
                        <TableCell className="py-1.5 font-medium">
                          {hasClock && (
                            <span className={`block tabular-nums text-[10px] text-muted-foreground ${isCapturing ? "" : "sm:hidden"}`}>
                              {formatClockOfDay(t.startSec)}–{formatClockOfDay(t.endSec)}
                            </span>
                          )}
                          <span className="text-xs sm:text-sm">{it.title || "—"}</span>
                          {it.notes && (
                            <span className="block text-[10px] font-normal text-muted-foreground">
                              {it.notes}
                            </span>
                          )}
                          {/* Mics inline — like the Start–End cell above, un-hide
                              during export: the Mic column is dropped from the
                              capture, so on a laptop/desktop (lg and up) the JPG
                              carried no mic assignments at all while the same
                              export from a phone did. Names too, so the image says
                              what the column says. */}
                          {slots.length > 0 && (
                            <span className={`mt-0.5 block text-[10px] font-normal text-muted-foreground ${isCapturing ? "" : "lg:hidden"}`}>
                              🎤{" "}
                              {slots
                                .map((s) => (s.member ? `${s.mic}·${s.member}` : s.mic))
                                .join("  ")}
                            </span>
                          )}
                        </TableCell>
                        {/* Duration — hidden on portrait */}
                        <TableCell className="hidden py-1.5 text-right tabular-nums text-xs sm:table-cell">
                          {formatDuration(it.duration_seconds)}
                        </TableCell>
                        {/* Running Time — hidden on portrait */}
                        <TableCell className="hidden py-1.5 text-right tabular-nums text-xs text-muted-foreground sm:table-cell">
                          {formatDuration(t?.accumulatedSec ?? 0)}
                        </TableCell>
                        {/* Mic — landscape/tablet only, hidden during export */}
                        <TableCell className={`py-1.5 text-xs text-muted-foreground ${isCapturing ? "hidden" : "hidden lg:table-cell"}`}>
                          {slots.length === 0
                            ? "—"
                            : slots.map((s) => s.member ? `${s.mic}·${s.member}` : s.mic).join("  ")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        {members.length > 0 && !isCapturing && (
          <Section title="Members & Mics">
            {lineup.length > 0 && (
              <p className="mb-1.5 text-xs text-muted-foreground">
                มางานนี้ {lineup.length}/{members.length} คน
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => {
                const present = lineup.length === 0 || lineup.includes(m.id);
                return (
                  <Badge
                    key={m.id}
                    variant="secondary"
                    className={cn(
                      "font-normal",
                      !present && "opacity-40 line-through"
                    )}
                  >
                    {m.mic_number != null ? `${m.mic_number} · ` : ""}
                    {m.nickname || m.name}
                  </Badge>
                );
              })}
            </div>
          </Section>
        )}
      </div>

      {/* Bottom quick menu — jump to edit tabs / live mode */}
      <div className="no-print flex flex-wrap items-center gap-2 border-t pt-4">
        <span className="self-center text-sm font-medium text-muted-foreground">
          ไปแก้ไข:
        </span>
        <Button variant="outline" size="sm" onClick={() => onNavigate("setlist")}>
          <Pencil className="h-3.5 w-3.5" /> Setlist + Run Time
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onNavigate("schedule")}
        >
          <Pencil className="h-3.5 w-3.5" /> นัดหมาย
        </Button>
        {showMic && (
          <Button variant="outline" size="sm" onClick={() => onNavigate("mic")}>
            <Pencil className="h-3.5 w-3.5" /> Mic Map
          </Button>
        )}
        <Button size="sm" asChild>
          <Link href={`/events/${event.id}/live`}>
            <Radio className="h-3.5 w-3.5" /> Live Mode
          </Link>
        </Button>
      </div>
    </div>
  );
}
