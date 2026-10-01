import type { SupabaseClient } from "@supabase/supabase-js";
import { bkkTodayKey } from "@/lib/time";

/**
 * What the Training landing says about each practice room (spec §G.6): how many
 * songs are on its list, homework still open, problems from its latest session,
 * and the last song someone ran there. Display only — nothing here writes.
 *
 * Every field is OPTIONAL on purpose. A source that failed to load leaves its
 * fields undefined rather than 0: an empty read is not an empty table, and
 * "ยังไม่มีการบ้าน" said off a failed request is a lie the band would act on.
 * The list renders a count only when it is known AND above zero.
 */
export type PracticeRoomStats = {
  songs?: number;
  homework?: number;
  /** problem notes on the room's most recent journal day */
  problems?: number;
  /** null = loaded, and nobody has run a song in this room yet */
  lastRun?: { at: string; title: string; speed: number } | null;
};

type SongRow = { event_id?: string | null };
type LogRow = {
  event_id?: string | null;
  category?: string | null;
  done?: boolean | null;
  log_date?: string | null;
};
type RunRow = {
  event_id?: string | null;
  song_title?: string | null;
  last_speed?: number | null;
  created_at?: string | null;
};

/** null for a source = that read failed; its fields stay unknown. */
export function practiceRoomStats(
  roomIds: readonly string[],
  src: { songs: readonly SongRow[] | null; logs: readonly LogRow[] | null; runs: readonly RunRow[] | null }
): Record<string, PracticeRoomStats> {
  const out: Record<string, PracticeRoomStats> = {};
  for (const id of roomIds) {
    const s: PracticeRoomStats = {};
    if (src.songs) s.songs = 0;
    if (src.logs) {
      s.homework = 0;
      s.problems = 0;
    }
    if (src.runs) s.lastRun = null;
    out[id] = s;
  }
  const room = (id: string | null | undefined) =>
    id && Object.prototype.hasOwnProperty.call(out, id) ? out[id] : null;

  for (const r of src.songs ?? []) {
    const s = room(r.event_id);
    if (s) s.songs = (s.songs ?? 0) + 1;
  }

  if (src.logs) {
    const latestDay: Record<string, string> = {};
    for (const l of src.logs) {
      const s = room(l.event_id);
      if (!s || !l.event_id) continue;
      if (l.category === "homework" && !l.done) s.homework = (s.homework ?? 0) + 1;
      if (l.log_date && (!latestDay[l.event_id] || l.log_date > latestDay[l.event_id])) {
        latestDay[l.event_id] = l.log_date;
      }
    }
    for (const l of src.logs) {
      const s = room(l.event_id);
      if (!s || !l.event_id) continue;
      if (l.category === "problem" && l.log_date && l.log_date === latestDay[l.event_id]) {
        s.problems = (s.problems ?? 0) + 1;
      }
    }
  }

  for (const r of src.runs ?? []) {
    const s = room(r.event_id);
    if (!s || !r.created_at || !r.song_title) continue;
    if (!s.lastRun || r.created_at > s.lastRun.at) {
      s.lastRun = { at: r.created_at, title: r.song_title, speed: r.last_speed ?? 1 };
    }
  }
  return out;
}

/**
 * The room to offer as "continue practising": the one with the latest run.
 * null when no room has a run (or the runs could not be read).
 */
export function continueRoomId(stats: Record<string, PracticeRoomStats> | undefined): string | null {
  let best: { id: string; at: string } | null = null;
  for (const [id, s] of Object.entries(stats ?? {})) {
    const at = s.lastRun?.at;
    if (at && (!best || at > best.at)) best = { id, at };
  }
  return best?.id ?? null;
}

/**
 * "13:20" on the day, "28 ก.ย. 13:20" otherwise — always Bangkok time, so the
 * server render and a laptop set to another zone say the same thing.
 */
export function lastRunWhen(at: string, todayKey = bkkTodayKey()): { day: string | null; time: string } {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return { day: null, time: "" };
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const day =
    bkkTodayKey(d) === todayKey
      ? null
      : new Intl.DateTimeFormat("th-TH", {
          timeZone: "Asia/Bangkok",
          day: "numeric",
          month: "short",
        }).format(d);
  return { day, time };
}

/**
 * The three reads behind practiceRoomStats, for the web page (server client) and
 * the desktop page (browser client) alike. Each one that errors is passed on as
 * null, never as [] — see the type's note.
 */
export async function loadPracticeRoomStats(
  supabase: Pick<SupabaseClient, "from">,
  roomIds: readonly string[]
): Promise<Record<string, PracticeRoomStats>> {
  if (roomIds.length === 0) return {};
  const ids = [...roomIds];
  const [songsRes, logsRes, runsRes] = await Promise.all([
    supabase.from("practice_songs").select("event_id").in("event_id", ids),
    supabase.from("practice_logs").select("event_id, category, done, log_date").in("event_id", ids),
    supabase
      .from("practice_runs")
      .select("event_id, song_title, last_speed, created_at")
      .in("event_id", ids)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  return practiceRoomStats(ids, {
    songs: songsRes.error ? null : ((songsRes.data ?? []) as SongRow[]),
    logs: logsRes.error ? null : ((logsRes.data ?? []) as LogRow[]),
    runs: runsRes.error ? null : ((runsRes.data ?? []) as RunRow[]),
  });
}
