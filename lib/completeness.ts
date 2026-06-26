// ---------------------------------------------------------------------------
// Event completeness — the single source of truth for "is this event ready to
// send for approval?". Drives BOTH the auto-transition (draft → pending_review)
// and the "ยังขาด…" (what's missing) panel on the event Summary.
//
// The required set is module-aware (EVENT_TYPES[event_type].modules) and was
// confirmed against the real reference event "Celebrate 3rd Year with NIKKO"
// (an idol show): it has on_location/dressing_room/stb/stage/booth call-times,
// a 4-song setlist, 7 mic assignments and a costume theme — but NO sound_check
// and NO lineup (event_members) rows, yet it is approved. So sound_check and
// lineup are NOT required, and photo time is excluded by design (the label's
// shared photographer / Staff Label fills it later).
// ---------------------------------------------------------------------------
import {
  EVENT_TYPES,
  type EventRow,
  type ScheduleItem,
  type SetlistItem,
  type ScheduleKind,
} from "@/lib/types";

export interface MissingItem {
  key: string;
  label: string;
}

export interface CompletenessResult {
  complete: boolean;
  missing: MissingItem[];
}

// Schedule call-times every performance event needs (photo is the Staff-Label
// exception; sound_check is optional; booth is added only when the type has it).
const REQUIRED_SCHEDULE: { kind: ScheduleKind; label: string }[] = [
  { kind: "on_location", label: "เวลาถึงสถานที่ (On Location)" },
  { kind: "dressing_room", label: "เวลาห้องแต่งตัว (Dressing Room)" },
  { kind: "stb", label: "เวลา Standby (STB)" },
  { kind: "stage", label: "เวลาขึ้นเวที (Stage)" },
];

const filled = (v: string | null | undefined): boolean => !!(v && v.trim());

export function eventCompleteness(args: {
  event: Pick<
    EventRow,
    | "name"
    | "event_date"
    | "venue"
    | "show_start_time"
    | "hard_out_time"
    | "event_type"
    | "costume_theme"
  >;
  schedule: Pick<ScheduleItem, "kind" | "start_time">[];
  setlist: Pick<SetlistItem, "kind">[];
  micCount: number;
  // Per-song mic_slots (the "ไมค์ + สมาชิก" set on setlist items) ALSO satisfy the
  // mic requirement — they're the same info as the event-level Mic Map, just more
  // granular. Without this the gate nagged "ขาด Mic Map" even after a band assigned
  // every song's mics in the setlist (the two were never linked).
  hasSongMics?: boolean;
}): CompletenessResult {
  const { event, schedule, setlist, micCount } = args;
  const modules = EVENT_TYPES[event.event_type]?.modules ?? EVENT_TYPES.idol.modules;
  const missing: MissingItem[] = [];

  if (!filled(event.name)) missing.push({ key: "name", label: "ชื่องาน" });
  if (!event.event_date) missing.push({ key: "event_date", label: "วันที่จัดงาน" });
  if (!filled(event.venue)) missing.push({ key: "venue", label: "สถานที่ (Venue)" });
  if (!filled(event.show_start_time))
    missing.push({ key: "show_start_time", label: "เวลาเริ่มโชว์" });
  if (!filled(event.hard_out_time))
    missing.push({ key: "hard_out_time", label: "เวลา Hard Out" });

  const schedHas = (kind: ScheduleKind) =>
    schedule.some((s) => s.kind === kind && filled(s.start_time));
  for (const r of REQUIRED_SCHEDULE)
    if (!schedHas(r.kind)) missing.push({ key: `sched_${r.kind}`, label: r.label });
  if (modules.booth && !schedHas("booth"))
    missing.push({ key: "sched_booth", label: "เวลาบูธ/แฟนไซน์ (Booth)" });

  const songCount = setlist.filter((s) => s.kind === "song").length;
  if (songCount < 1)
    missing.push({ key: "setlist", label: "เพลงใน Setlist อย่างน้อย 1 เพลง" });

  if (modules.micMap && micCount < 1 && !args.hasSongMics)
    missing.push({ key: "mic", label: "ตำแหน่งไมค์ (Mic Map หรือไมค์ในเพลง)" });
  if (modules.costume && !filled(event.costume_theme))
    missing.push({ key: "costume", label: "ธีมการแต่งกาย (Costume)" });

  return { complete: missing.length === 0, missing };
}
