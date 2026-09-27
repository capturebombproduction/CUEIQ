import type { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";

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
};

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
  }: {
    sourceId: string;
    /** What the source is called in an error: "งานต้นฉบับ" / "แม่แบบ". */
    sourceLabel: string;
    buildEvent: (source: Row) => Row;
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
  const readErrors = reads.filter((r) => r.error);
  if (readErrors.length) {
    throw new Error(
      `โหลดข้อมูล${sourceLabel}ไม่สำเร็จ (${readErrors
        .map((r) => r.part.label)
        .join(", ")}) — ยังไม่ได้สร้างงานใหม่`
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

  const { data: created, error: insErr } = await supabase
    .from("events")
    .insert(buildEvent(src as Row))
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
  return { newId, failed, attempted };
}
