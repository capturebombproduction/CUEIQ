import { CalendarDays, MapPin, Music2, Clock, Users, Shirt } from "lucide-react";
import { PrintButton } from "@/components/print-button";
import { BandSkin } from "@/components/band-skin";
import { createClient } from "@/lib/supabase/server";
import {
  computeSetlistTimes,
  formatDuration,
  formatClockOfDay,
  parseClockToSeconds,
  shortClock,
} from "@/lib/time";
import {
  SETLIST_KIND_SHORT,
  SCHEDULE_KIND_LABELS,
  EVENT_TYPES,
  type EventType,
  type MicSlot,
  type ScheduleKind,
  type SetlistKind,
} from "@/lib/types";

export const dynamic = "force-dynamic";

interface SharedBundle {
  event: {
    id: string;
    name: string;
    event_date: string | null;
    venue: string | null;
    event_type: EventType;
    show_start_time: string | null;
    hard_out_time: string | null;
    status: string;
    notes: string | null;
    map_url: string | null;
    costume_theme: string | null;
  };
  group: { id: string; name: string; color: string | null; skin: string | null } | null;
  schedule: {
    id: string;
    kind: ScheduleKind;
    label: string | null;
    location: string | null;
    start_time: string | null;
    end_time: string | null;
    notes: string | null;
  }[];
  setlist: {
    id: string;
    kind: SetlistKind;
    title: string;
    duration_seconds: number;
    buffer_before_seconds: number;
    buffer_after_seconds: number;
    mic_slots: MicSlot[];
    notes: string | null;
  }[];
  members: {
    id: string;
    name: string;
    nickname: string | null;
    mic_number: number | null;
  }[];
}

function fmtDate(date: string | null): string {
  if (!date) return "ยังไม่ระบุวันที่";
  const d = new Date(`${date}T00:00:00`);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("th-TH", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export async function generateMetadata({ params }: { params: { token: string } }) {
  const supabase = createClient();
  const { data } = await supabase.rpc("get_shared_event", { p_token: params.token });
  const name = (data as SharedBundle | null)?.event?.name;
  return { title: name ? `${name} · Run Sheet` : "Run Sheet · CueIQ" };
}

export default async function SharePage({ params }: { params: { token: string } }) {
  const supabase = createClient();
  const { data } = await supabase.rpc("get_shared_event", { p_token: params.token });
  const bundle = data as SharedBundle | null;

  if (!bundle || !bundle.event) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-center">
        <div className="space-y-2">
          <Music2 className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">ลิงก์ไม่ถูกต้องหรือถูกปิดการแชร์แล้ว</h1>
          <p className="text-sm text-muted-foreground">
            ลองขอลิงก์ใหม่จากผู้จัดงานอีกครั้ง
          </p>
        </div>
      </main>
    );
  }

  const { event, group, schedule, setlist, members } = bundle;
  const startSec = parseClockToSeconds(event.show_start_time);
  const hardOutSec = parseClockToSeconds(event.hard_out_time);
  const hasClock = startSec != null;
  const timing = computeSetlistTimes(setlist, startSec ?? 0, hardOutSec);
  const typeLabel = EVENT_TYPES[event.event_type]?.label ?? event.event_type;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <BandSkin hex={group?.skin} />
      {/* print / save-pdf (hidden on the printed page itself) */}
      <div className="no-print flex justify-end">
        <PrintButton />
      </div>

      {/* header */}
      <header className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm print-flat">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: group?.color || "var(--primary)" }}
          />
          {group?.name ?? "—"} · {typeLabel}
        </div>
        <h1 className="text-2xl font-bold leading-tight">{event.name}</h1>
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          <p className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 shrink-0" />
            {fmtDate(event.event_date)}
            {event.show_start_time && (
              <span className="tabular-nums">· เริ่ม {shortClock(event.show_start_time)}</span>
            )}
            {event.hard_out_time && (
              <span className="tabular-nums">· Hard out {shortClock(event.hard_out_time)}</span>
            )}
          </p>
          {event.venue && (
            <p className="flex items-center gap-2">
              <MapPin className="h-4 w-4 shrink-0" />
              <span>{event.venue}</span>
            </p>
          )}
          {event.costume_theme && (
            <p className="flex items-center gap-2">
              <Shirt className="h-4 w-4 shrink-0" />
              <span>ธีมชุด: {event.costume_theme}</span>
            </p>
          )}
        </div>
        {event.notes && (
          <p className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{event.notes}</p>
        )}
      </header>

      {/* schedule */}
      {schedule.length > 0 && (
        <section className="space-y-2 rounded-2xl border bg-card p-5 shadow-sm print-flat">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock className="h-4 w-4" /> กำหนดการ / นัดหมาย
          </h2>
          <ul className="divide-y">
            {schedule.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                <span className="w-28 shrink-0 tabular-nums text-sm font-medium">
                  {s.start_time ? shortClock(s.start_time) : "—"}
                  {s.end_time ? `–${shortClock(s.end_time)}` : ""}
                </span>
                <span className="text-sm font-medium">
                  {s.label || SCHEDULE_KIND_LABELS[s.kind] || s.kind}
                </span>
                {s.location && (
                  <span className="text-sm text-muted-foreground">@ {s.location}</span>
                )}
                {s.notes && (
                  <span className="w-full pl-28 text-xs text-muted-foreground">{s.notes}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* setlist run sheet */}
      {setlist.length > 0 && (
        <section className="space-y-2 rounded-2xl border bg-card p-5 shadow-sm print-flat">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Music2 className="h-4 w-4" /> เซ็ตลิสต์ / Run Sheet
            <span className="ml-auto font-normal normal-case tabular-nums text-muted-foreground">
              รวม {formatDuration(timing.totalSeconds)}
              {timing.isOver && <span className="text-destructive"> · เกิน Hard out</span>}
            </span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">#</th>
                  <th className="py-1.5 pr-2 font-medium">ประเภท</th>
                  {hasClock && <th className="py-1.5 pr-2 font-medium tabular-nums">เริ่ม–จบ</th>}
                  <th className="py-1.5 pr-2 font-medium">ชื่อเพลง / หัวข้อ</th>
                  <th className="py-1.5 pr-2 text-right font-medium">ยาว</th>
                  <th className="py-1.5 pr-2 text-right font-medium">สะสม</th>
                </tr>
              </thead>
              <tbody>
                {setlist.map((it, i) => {
                  const row = timing.rows[i];
                  return (
                    <tr key={it.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-2 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                          {SETLIST_KIND_SHORT[it.kind] ?? it.kind}
                        </span>
                      </td>
                      {hasClock && (
                        <td className="py-2 pr-2 tabular-nums text-muted-foreground">
                          {formatClockOfDay(row.startSec)}–{formatClockOfDay(row.endSec)}
                        </td>
                      )}
                      <td className="py-2 pr-2">
                        <div className="font-medium">{it.title || "—"}</div>
                        {it.mic_slots?.length > 0 && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {it.mic_slots
                              .filter((m) => m.member)
                              .map((m) => `${m.mic}→${m.member}`)
                              .join(" · ")}
                          </div>
                        )}
                        {it.notes && (
                          <div className="mt-0.5 text-xs text-muted-foreground">{it.notes}</div>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {formatDuration(it.duration_seconds)}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {formatDuration(row.accumulatedSec)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* members */}
      {members.length > 0 && (
        <section className="space-y-2 rounded-2xl border bg-card p-5 shadow-sm print-flat">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="h-4 w-4" /> สมาชิก
          </h2>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <span
                key={m.id}
                className="rounded-full border px-2.5 py-1 text-sm"
              >
                {m.mic_number != null && (
                  <span className="mr-1 tabular-nums font-semibold">{m.mic_number}</span>
                )}
                {m.nickname || m.name}
              </span>
            ))}
          </div>
        </section>
      )}

      <footer className="pb-8 pt-2 text-center text-xs text-muted-foreground">
        เอกสารดูอย่างเดียว (read-only) · สร้างด้วย <span className="font-semibold">CueIQ</span>
      </footer>
    </main>
  );
}
