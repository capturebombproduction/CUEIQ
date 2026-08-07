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

/**
 * A setlist row as this gate needs to see it. `kind` is all it has ever required;
 * `title` is optional ON PURPOSE — `undefined` means "the caller did not tell us",
 * which is a different answer from "empty". See the row rules below.
 */
export type CompletenessSetlistItem = Pick<SetlistItem, "kind"> &
  Partial<Pick<SetlistItem, "title">>;

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
  setlist: CompletenessSetlistItem[];
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

  // ── A song row with no name is not a shippable song ───────────────────────
  // Round 10 (scope corrected in the round-10 repair pass). What this rule does,
  // exactly: a `kind === "song"` row whose title is blank does not count towards
  // "อย่างน้อย 1 เพลง" and is named separately, because an unnamed row is a mystery
  // to whoever reads the run sheet at the venue. "+ เพลง" inserts rows with
  // `title: ""` (components/event/setlist-builder.tsx addItem), so this is a state
  // a real band lands in by pressing a button and walking away.
  //
  // WHAT THIS RULE DOES NOT DO, and cannot: catch a row whose library song was
  // DELETED. `setlist_items.song_id` is a real FK with ON DELETE SET NULL
  // (migration 0012:26), so a delete leaves the row with its TITLE INTACT and only
  // `song_id` wiped — byte-identical to a song somebody typed by hand, which is a
  // supported way to build a setlist. Nothing here can tell those two apart, and
  // guessing wrong would push a perfectly good show out of the approval queue.
  // That case is covered where it can actually be answered — lib/show-readiness.ts
  // (`silent`, surfaced by the pre-show preflight) and lib/audio-targets.ts, which
  // ask "will this row make a sound?" instead of "is this row complete?".
  //
  // A `librarySongIds` parameter was added this round to flag rows whose song_id is
  // absent from the band's library, and it was DELETED again in the repair pass. It
  // could never fire on a real dead link: the FK guarantees every non-null song_id
  // resolves to a live songs row (measured on prod — 0 of 112 song rows across 44
  // events pointed outside the library). The only way that branch could ever have
  // gone true is a caller whose library list came back short — a failed or paginated
  // or wrongly-scoped read — and A FAILED READ IS NOT A ZERO COUNT. It would have
  // printed "ไฟล์หายไปจากคลัง" over a healthy setlist and auto-reverted the show to
  // Draft. Do not re-add it without a DB-side signal that a link is actually dead.
  //
  // The title rule is deliberately opt-in on the field being PRESENT, and that is
  // load-bearing: a caller that maps rows down to `{ kind }` gets `undefined`, which
  // means "not told", not "blank" — reading it as blank would flag every song of
  // every event at once. Both Overview boards now pass the real `title` through
  // (app/(app)/overview/page.tsx, desktop/src/pages/overview.tsx) so they give the
  // same answer as the event pages, which pass `bundle.setlist` verbatim.
  let untitled = 0; // rows nobody has filled in — nothing to play, nothing to print
  let songCount = 0;
  for (const s of setlist) {
    if (s.kind !== "song") continue;
    if (s.title !== undefined && !filled(s.title)) {
      untitled++;
      continue;
    }
    songCount++;
  }
  if (songCount < 1)
    missing.push({ key: "setlist", label: "เพลงใน Setlist อย่างน้อย 1 เพลง" });
  // Named separately from the count above so the panel says WHICH problem it is.
  // This blocks on its own even when the other songs are fine: an unnamed row is a
  // mystery to whoever reads the run sheet at the venue.
  if (untitled > 0)
    missing.push({
      key: "setlist_untitled",
      label: `เพลงใน Setlist ที่ยังไม่ได้ใส่ชื่อ (${untitled} แถว)`,
    });

  if (modules.micMap && micCount < 1 && !args.hasSongMics)
    missing.push({ key: "mic", label: "ตำแหน่งไมค์ (Mic Map หรือไมค์ในเพลง)" });
  if (modules.costume && !filled(event.costume_theme))
    missing.push({ key: "costume", label: "ธีมการแต่งกาย (Costume)" });

  return { complete: missing.length === 0, missing };
}
