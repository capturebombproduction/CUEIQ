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
  const [isCapturing, setIsCapturing] = useState(false);

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

  async function exportJpg() {
    const el = captureRef.current;
    if (!el) return;
    const prevWidth = el.style.width;
    setExporting(true);
    setIsCapturing(true); // swap iframe → static map
    await new Promise((r) => setTimeout(r, 120)); // wait for re-render
    try {
      const { toJpeg } = await import("html-to-image");
      // Force 600px reflow before capture so text doesn't wrap at mobile width
      el.style.width = "600px";
      await new Promise((r) => setTimeout(r, 80)); // wait for browser reflow
      const dataUrl = await toJpeg(el, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
        quality: 0.92,
      });
      const filename = `${event.name.replace(/[^\w\-]+/g, "_") || "summary"}.jpg`;

      // Web Share API — saves directly to gallery on iOS/Android
      if (navigator.share && navigator.canShare) {
        try {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const file = new File([blob], filename, { type: "image/jpeg" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: event.name });
            toast.success("แชร์รูปสรุปแล้ว");
            return;
          }
        } catch {
          // share cancelled or unsupported — fall through to download
        }
      }

      // Desktop fallback
      const a = document.createElement("a");
      a.download = filename;
      a.href = dataUrl;
      a.click();
      toast.success("บันทึกรูปสรุปแล้ว");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ — แคปหน้าจอแทนได้", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      el.style.width = prevWidth; // always restore — even if capture threw
      setIsCapturing(false);
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
        <Button variant="outline" onClick={exportJpg} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageDown className="h-4 w-4" />
          )}
          บันทึกเป็นรูป (JPG)
        </Button>
        <p className="self-center text-xs text-muted-foreground">
          หน้านี้เป็นสรุปอย่างเดียว — แก้ข้อมูลที่แท็บ/ปุ่มด้านล่าง
        </p>
      </div>

      {/* Captured summary */}
      <div
        ref={captureRef}
        className="space-y-5 rounded-lg border bg-card p-6 text-foreground"
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
        <Section title="Call Time">
          <Line
            label="On Location"
            value={shortClock(sched("on_location")?.start_time)}
          />
          <Line label="Dressing Room" value={sched("dressing_room")?.location} />
          <Line
            label="Photo Session"
            value={shortClock(sched("photo")?.start_time)}
          />
          <Line label="Costume Theme" value={event.costume_theme} />
        </Section>

        {/* Stage & Booth */}
        <Section title="Showtime">
          <Line label="Standby Time" value={shortClock(sched("stb")?.start_time)} />
          <Line label="Stage" value={showWindow} />
          <Line label="Booth" value={range(booth)} />
          <Line label="Booth Location" value={booth?.location} />
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
                          {slots.length > 0 && (
                            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground lg:hidden">
                              🎤 {slots.map((s) => s.mic).join(" ")}
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
