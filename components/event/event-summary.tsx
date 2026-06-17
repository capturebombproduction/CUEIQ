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
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  SETLIST_KIND_SHORT,
  type EventRow,
  type Group,
  type Member,
  type ScheduleItem,
  type ScheduleKind,
  type SetlistItem,
} from "@/lib/types";

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

export function EventSummary({
  event,
  schedule,
  setlist,
  members,
  showMic,
  onNavigate,
}: {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  members: Member[];
  showMic: boolean;
  onNavigate: (view: string) => void;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const showStartSec = parseClockToSeconds(event.show_start_time);
  const hardOutSec = parseClockToSeconds(event.hard_out_time);
  const hasClock = showStartSec != null;
  const timing = computeSetlistTimes(setlist, showStartSec ?? 0, hardOutSec);

  const sched = (kind: ScheduleKind) => schedule.find((s) => s.kind === kind);
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

  const booth = sched("booth");
  const mapQuery = event.venue || event.name;

  async function exportPng() {
    if (!captureRef.current) return;
    setExporting(true);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(captureRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
      });
      const a = document.createElement("a");
      a.download = `${event.name.replace(/[^\w\-]+/g, "_") || "summary"}.png`;
      a.href = dataUrl;
      a.click();
      toast.success("บันทึกรูปสรุปแล้ว 🖼️");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ — แคปหน้าจอแทนได้", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action bar — not included in the exported image */}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={`/events/${event.id}/live`}>
            <Radio className="h-4 w-4" /> เข้า Live Mode
          </Link>
        </Button>
        <Button variant="outline" onClick={exportPng} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageDown className="h-4 w-4" />
          )}
          บันทึกเป็นรูป (PNG)
        </Button>
        <p className="self-center text-xs text-muted-foreground">
          หน้านี้เป็นสรุปอย่างเดียว — แก้ข้อมูลที่แท็บ/ปุ่มด้านล่าง
        </p>
      </div>

      {/* Captured summary */}
      <div
        ref={captureRef}
        className="space-y-5 rounded-lg border bg-card p-5 text-foreground"
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

        {/* Location */}
        <Section title="Location">
          <Line label="สถานที่" value={event.venue} />
          {event.map_url && (
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
                เปิดแผนที่ <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          )}
          {mapQuery && (
            <div className="overflow-hidden rounded-md border">
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

        {/* Appointments */}
        <Section title="นัดหมายเวลา">
          <Line
            label="On Location"
            value={shortClock(sched("on_location")?.start_time)}
          />
          <Line label="ห้องพัก" value={sched("dressing_room")?.location} />
          <Line
            label="เวลาถ่ายรูป"
            value={shortClock(sched("photo")?.start_time)}
          />
          <Line label="COSTUME THEME" value={event.costume_theme} />
        </Section>

        {/* Stage & Booth */}
        <Section title="เวลาการแสดง">
          <Line label="STAGE" value={showWindow} />
          <Line label="STB Show" value={shortClock(sched("stb")?.start_time)} />
          <Line label="BOOTH" value={range(booth)} />
          <Line label="Booth Location" value={booth?.location} />
        </Section>

        {/* Setlist — detailed table */}
        <Section title={`Setlist & Show Flow (${setlist.length})`}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pb-1 text-sm">
            <span className="flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              เวลารวม{" "}
              <b className="tabular-nums">{formatDuration(timing.totalSeconds)}</b>
            </span>
            {hasClock && (
              <span className="tabular-nums text-muted-foreground">
                {formatClockOfDay(showStartSec!)}–
                {formatClockOfDay(timing.endSec)}
              </span>
            )}
            {hardOutSec != null &&
              (timing.isOver ? (
                <Badge variant="destructive" className="gap-1">
                  <AlarmClock className="h-3.5 w-3.5" /> เกิน Hard Out{" "}
                  {formatDuration(timing.overBy)}
                </Badge>
              ) : (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> เหลือ{" "}
                  {formatDuration(Math.max(0, hardOutSec - timing.endSec))}
                </Badge>
              ))}
          </div>

          {setlist.length === 0 ? (
            <p className="text-sm text-muted-foreground">ยังไม่มีรายการ</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 text-right">#</TableHead>
                    <TableHead className="w-14">ประเภท</TableHead>
                    {hasClock && (
                      <TableHead className="w-28">เริ่ม–จบ</TableHead>
                    )}
                    <TableHead>ชื่อเพลง / หัวข้อ</TableHead>
                    <TableHead className="w-16 text-right">ความยาว</TableHead>
                    <TableHead className="w-16 text-right">สะสม</TableHead>
                    <TableHead className="w-40">ไมค์ → สมาชิก</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {setlist.map((it, idx) => {
                    const t = timing.rows[idx];
                    const slots = it.mic_slots ?? [];
                    return (
                      <TableRow key={it.id} className={t?.overHardOut ? "bg-destructive/5" : ""}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {idx + 1}
                        </TableCell>
                        <TableCell className="text-[10px] font-bold text-muted-foreground">
                          {SETLIST_KIND_SHORT[it.kind]}
                        </TableCell>
                        {hasClock && (
                          <TableCell className="tabular-nums text-xs text-muted-foreground">
                            {formatClockOfDay(t.startSec)}–
                            {formatClockOfDay(t.endSec)}
                          </TableCell>
                        )}
                        <TableCell className="font-medium">
                          {it.title || "—"}
                          {it.notes && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {it.notes}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(it.duration_seconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatDuration(t?.accumulatedSec ?? 0)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {slots.length === 0
                            ? "—"
                            : slots
                                .map((s) =>
                                  s.member ? `${s.mic}·${s.member}` : s.mic
                                )
                                .join("  ")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        {members.length > 0 && (
          <Section title="สมาชิก + ไมค์">
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => (
                <Badge key={m.id} variant="secondary" className="font-normal">
                  {m.mic_number != null ? `${m.mic_number} · ` : ""}
                  {m.nickname || m.name}
                </Badge>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Bottom quick menu — jump to edit tabs / live mode */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
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
