import type { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { formatClockOfDay, parseClockToSeconds } from "@/lib/time";
import { aroundTheClock, stageAnchorSeconds } from "@/lib/day-order";
import { hasLeft, leftOnKey } from "@/lib/member-status";

type Client = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

// ONE clone for both ways a show gets made from another: "ก๊อปงาน" on a card and
// "สร้างจากแม่แบบ". They used to be two copies of the same loop, and when the
// template path was hardened (read errors checked before anything is created,
// the anon-degraded empty read caught, a partial copy named part by part) the
// duplicate path was not — so a hiccup mid-read made an EMPTY show under
// "ก๊อปงานเรียบร้อย". Nor did it copy the lineup, which was built the same day
// (ecd4aa1 / afe84c3, 2026-06-19) and simply never added: a band that duplicates
// its last show twice a week re-picked all seven members every time, or didn't,
// and the run sheet then said nobody had been chosen.
//
// Audio bytes are never copied — the song link (setlist_items.song_id) carries
// the master, and a per-show upload stays with its show.
export const CLONE_PARTS = [
  { table: "schedule_items", label: "คิว", drop: ["id", "event_id"] },
  {
    table: "setlist_items",
    label: "เซ็ตลิสต์",
    drop: ["id", "event_id", "audio_path", "audio_name"],
  },
  { table: "mic_assignments", label: "ผังไมค์", drop: ["id", "event_id", "created_at"] },
  { table: "event_members", label: "รายชื่อคนมา", drop: ["id", "event_id", "created_at"] },
] as const;

export type CloneResult = {
  newId: string;
  /** Labels of parts that had rows to copy and failed to. */
  failed: string[];
  /** How many parts had rows to copy at all. */
  attempted: number;
  /** Seconds the whole day was moved by (0 = not asked); null = asked, but the
   *  source had no stage time to measure from, so nothing moved. */
  shiftedBy: number | null;
};

// ─── moving the day ──────────────────────────────────────────────────────────
// Measured 2026-09-28 over Seishin Kakumei's 27 shows: the rows BEFORE the stage
// sit at nearly the same distance from it every time — arrive and dressing room
// 120 min before, photo 60–70, STB 10–15 — whatever the stage time is. So a copy
// of last week's show only needs the NEW stage time; move every row by the same
// amount and four of the five come out right (the booth, which follows the
// organiser, is the one to check). That used to be five time fields retyped, twice
// a week.

// The day's clock order lives in lib/day-order.ts (pure - the share page reads it too).
export { stageAnchorSeconds, aroundTheClock, dayOrderSeconds } from "@/lib/day-order";

/** A time-of-day moved by `deltaSec`, wrapped to the day ("HH:MM:SS"). A value
 *  that is not a clock time (null, blank) is left exactly as it was. */
export function shiftClock<T>(value: T, deltaSec: number): T | string {
  const sec = parseClockToSeconds(value as unknown as string | null);
  return sec == null ? value : formatClockOfDay(sec + deltaSec, true);
}

function reparent(rows: Row[], drop: readonly string[], eventId: string): Row[] {
  return rows.map((row) => {
    const o: Row = { ...row };
    for (const k of drop) delete o[k];
    o.event_id = eventId;
    return o;
  });
}

/**
 * Read `sourceId` and everything that hangs off it, and only if every read came
 * back cleanly create the new event (`buildEvent` turns the source row into the
 * insert) and copy the parts into it.
 *
 * Throws — having created NOTHING — when a read fails, or when every part comes
 * back empty and the session has gone (that is what an anon-degraded read looks
 * like; see lib/auth-session.ts). After the event exists it never throws for a
 * part: the caller gets `failed` and says exactly what is missing.
 */
export async function cloneEvent(
  supabase: Client,
  {
    sourceId,
    sourceLabel,
    buildEvent,
    stageStart,
  }: {
    sourceId: string;
    /** What the source is called in an error: "งานต้นฉบับ" / "แม่แบบ". */
    sourceLabel: string;
    buildEvent: (source: Row) => Row;
    /** The copy's stage time ("HH:MM"). Given, the whole day — every schedule
     *  row, the show start and the hard out — moves by the same amount, so the
     *  run of the day and the setlist's slot keep their shape. */
    stageStart?: string;
  }
): Promise<CloneResult> {
  const { data: src, error: srcErr } = await supabase
    .from("events")
    .select("*")
    .eq("id", sourceId)
    .single();
  if (srcErr || !src) throw new Error(`ไม่พบ${sourceLabel} — ยังไม่ได้สร้างงานใหม่`);

  const reads = await Promise.all(
    CLONE_PARTS.map(async (part) => {
      const { data, error } = await supabase
        .from(part.table)
        .select("*")
        .eq("event_id", sourceId);
      return { part, error, rows: ((data as Row[] | null) ?? []) as Row[] };
    })
  );
  // The band's members, to leave out of the copy anyone who has left it (0054). 2026-10-27,
  // hunt 8: the copy took the source's lineup as it was, so duplicating last week's show
  // put a member who left in between onto the new one - and a lineup that holds a member
  // keeps them on that show (lib/member-status.ts), on its sheets, Live and share page.
  // Read with the rest, so a failure here also creates nothing.
  const groupId = (src as Row).group_id as string | null | undefined;
  const memberRead = groupId
    ? await supabase.from("members").select("id, name, nickname, left_at").eq("group_id", groupId)
    : { data: [], error: null };

  const readErrors = reads.filter((r) => r.error);
  if (readErrors.length || memberRead.error) {
    throw new Error(
      `โหลดข้อมูล${sourceLabel}ไม่สำเร็จ (${[
        ...readErrors.map((r) => r.part.label),
        ...(memberRead.error ? ["สมาชิกวง"] : []),
      ].join(", ")}) — ยังไม่ได้สร้างงานใหม่`
    );
  }
  // A real show or template has SOMETHING in it, so every list empty at once is
  // what a read that silently fell back to the anon key looks like. Only ask —
  // a genuinely bare source is cheap to confirm and correct to copy.
  if (reads.every((r) => r.rows.length === 0) && !(await hasLiveSession())) {
    throw new Error(
      `เซสชันหมดอายุระหว่างโหลด${sourceLabel} ยังไม่ได้สร้างงานใหม่ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง`
    );
  }

  let shiftedBy: number | null = 0;
  const target = stageStart ? parseClockToSeconds(stageStart) : null;
  if (target != null) {
    const scheduleRows = reads.find((r) => r.part.table === "schedule_items")?.rows ?? [];
    const anchor = stageAnchorSeconds(scheduleRows, src as Row);
    // The nearer way round the clock: a 23:00 set moved to 01:00 is "+2:00", not
    // "−22:00". Every row lands on the same clock time either way (shiftClock
    // wraps at midnight) — only what the toast reports changes.
    shiftedBy = anchor == null ? null : aroundTheClock(anchor, target);
  }

  const eventRow = buildEvent(src as Row);

  // Leave out of the copy a member who left before its date - or at all, when the copy has
  // no date yet (a template's, or one left blank): the same rule as membersForShow. Their
  // Mic Map rows go too; those hold a name, not an id, so only a name no one still in the
  // band answers to.
  type Mem = { id: string; name: string | null; nickname: string | null; left_at?: string | null };
  const roster = ((memberRead.data as Mem[] | null) ?? []) as Mem[];
  const newDate = (eventRow.event_date as string | null | undefined) ?? null;
  const gone = roster.filter((m) => {
    if (!hasLeft(m)) return false;
    const left = leftOnKey(m);
    return !(newDate && left && newDate <= left);
  });
  if (gone.length) {
    const goneIds = new Set(gone.map((m) => m.id));
    const labels = (m: Mem) => [m.nickname?.trim(), m.name?.trim()].filter((s): s is string => !!s);
    const stillHere = new Set(roster.filter((m) => !goneIds.has(m.id)).flatMap(labels));
    const goneNames = new Set(gone.flatMap(labels).filter((s) => !stillHere.has(s)));
    for (const r of reads) {
      if (r.part.table === "event_members") {
        r.rows = r.rows.filter((row) => !goneIds.has(row.member_id as string));
      } else if (r.part.table === "mic_assignments") {
        r.rows = r.rows.filter((row) => !goneNames.has(String(row.holder_name ?? "").trim()));
      } else if (r.part.table === "setlist_items") {
        // ...and their seat in each song's "ไมค์ + สมาชิก" (mic_slots, a name too). 2026-10-27,
        // hunt 9: the Mic Map lost them but every song of the copy still said "MIC 2 Bell" -
        // on Live's now/next mic line, the summary, the Mic Map's per-song list and the Excel.
        // Only the slot goes; the row (an MC's notes, a loop) is copied as it was.
        r.rows = r.rows.map((row) => {
          const slots = row.mic_slots;
          if (!Array.isArray(slots)) return row;
          const kept = slots.filter(
            (s) => !goneNames.has(String((s as { member?: unknown } | null)?.member ?? "").trim())
          );
          return kept.length === slots.length ? row : { ...row, mic_slots: kept };
        });
      }
    }
  }

  if (shiftedBy) {
    for (const k of ["show_start_time", "hard_out_time"]) {
      if (k in eventRow) eventRow[k] = shiftClock(eventRow[k], shiftedBy);
    }
    for (const r of reads) {
      if (r.part.table !== "schedule_items") continue;
      const by = shiftedBy;
      r.rows = r.rows.map((row) => ({
        ...row,
        start_time: shiftClock(row.start_time, by),
        end_time: shiftClock(row.end_time, by),
      }));
    }
  }

  // The typed stage time IS the copy's show start. Moving the day cannot put it
  // there when the source had no show start (shiftClock leaves a null a null): the
  // rows moved from a stage row, or nothing moved at all, and the copy opened with
  // ขึ้นเวที "—", no clock on its setlist, and "เวลาเริ่มโชว์" listed missing — right
  // after the user typed it.
  if (target != null && !eventRow.show_start_time) {
    eventRow.show_start_time = formatClockOfDay(target, true);
  }

  const { data: created, error: insErr } = await supabase
    .from("events")
    .insert(eventRow)
    .select("id")
    .single();
  if (insErr || !created) {
    throw new Error(insErr?.message ?? "สร้างงานใหม่ไม่สำเร็จ");
  }
  const newId = (created as { id: string }).id;

  const failed: string[] = [];
  let attempted = 0;
  for (const { part, rows } of reads) {
    if (!rows.length) continue; // nothing to copy is not a failure
    attempted += 1;
    const { error } = await supabase
      .from(part.table)
      .insert(reparent(rows, part.drop, newId));
    if (error) failed.push(part.label);
  }
  return { newId, failed, attempted, shiftedBy };
}
