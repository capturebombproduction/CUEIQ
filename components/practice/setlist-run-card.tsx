"use client";

import { useEffect, useMemo, useState } from "react";
import { ListOrdered, Loader2, Play, Square } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { bkkTodayKey, monthBeforeKey } from "@/lib/time";
import {
  orderShowsForPractice,
  setlistQueue,
  type QueueEntry,
  type SetlistShow,
} from "@/lib/practice-setlist";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Song } from "@/lib/types";

function whenLabel(date: string, today: string): string {
  const d = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
  if (date === today) return `วันนี้ · ${d}`;
  return date > today ? `งานถัดไป · ${d}` : `ผ่านมาแล้ว · ${d}`;
}

/**
 * "ซ้อมตามเซ็ตลิสต์" — play a show's setlist top to bottom, each song starting as
 * the last one ends. Loads its own shows (this band, the last month onward) with
 * the page's own client, so the web page and the desktop app get it without
 * either loader changing; offline it just says it can't load. Playback, and
 * the auto-advance, live in PracticePlayer — this card picks and displays.
 * See lib/practice-setlist.ts for why it exists.
 */
export function SetlistRunCard({
  groupId,
  songsById,
  playable,
  running,
  loadingSongId,
  onPlay,
  onStop,
}: {
  groupId: string;
  songsById: Map<string, Song>;
  playable: (s: Song) => boolean;
  /** The run in progress, if any: which show and which position in its queue. */
  running: { showId: string; index: number } | null;
  loadingSongId: string | null;
  onPlay: (showId: string, queue: QueueEntry[], index: number) => void;
  onStop: () => void;
}) {
  const today = bkkTodayKey();
  const [shows, setShows] = useState<SetlistShow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showId, setShowId] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await createClient()
        .from("events")
        .select("id, name, event_date, setlist_items(id, title, kind, song_id, sort_order)")
        .eq("group_id", groupId)
        .eq("is_template", false)
        .eq("is_practice", false)
        .gte("event_date", monthBeforeKey(bkkTodayKey()));
      if (!alive) return;
      if (error) {
        setFailed(true);
        return;
      }
      const ordered = orderShowsForPractice((data ?? []) as SetlistShow[], bkkTodayKey());
      setShows(ordered);
      setShowId((cur) => cur || ordered[0]?.id || "");
    })();
    return () => {
      alive = false;
    };
  }, [groupId]);

  const show = shows?.find((s) => s.id === showId) ?? null;
  const { queue, missing } = useMemo(
    () => (show ? setlistQueue(show, songsById, playable) : { queue: [], missing: [] }),
    [show, songsById, playable]
  );
  const runningHere = running && show && running.showId === show.id ? running : null;

  if (failed) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        ซ้อมตามเซ็ตลิสต์: โหลดเซ็ตลิสต์ของงานไม่ได้ — ต้องต่อเน็ต
      </p>
    );
  }
  if (!shows) {
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังโหลดเซ็ตลิสต์ของงาน…
      </p>
    );
  }
  if (shows.length === 0 || !show) return null; // no show with a playable set this month

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <ListOrdered className="h-4 w-4" /> ซ้อมตามเซ็ตลิสต์
        </h2>
        <select
          aria-label="เลือกงานที่จะซ้อม"
          value={show.id}
          onChange={(e) => setShowId(e.target.value)}
          className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm"
        >
          {shows.map((s) => (
            <option key={s.id} value={s.id}>
              {whenLabel(s.event_date, today)} · {s.name}
            </option>
          ))}
        </select>
      </div>

      <ol className="divide-y rounded-lg border">
        {queue.map((q, i) => {
          const active = runningHere?.index === i;
          return (
            <li key={`${q.itemId}-${i}`}>
              <button
                onClick={() => onPlay(show.id, queue, i)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                  active ? "bg-primary/10 font-semibold" : "hover:bg-muted/50"
                )}
              >
                <span className="w-5 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{q.song.title}</span>
                {active && loadingSongId === q.song.id && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          ข้ามเพราะยังไม่มีไฟล์เสียงในคลัง: {missing.join(", ")}
        </p>
      )}

      {runningHere ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            กำลังเล่นเพลงที่ {runningHere.index + 1}/{queue.length} — จบแล้วเล่นเพลงถัดไปเอง
          </span>
          <Button variant="outline" size="sm" onClick={onStop}>
            <Square className="h-3.5 w-3.5" /> หยุดเล่นต่อ
          </Button>
        </div>
      ) : (
        <Button
          className="w-full"
          disabled={queue.length === 0}
          onClick={() => onPlay(show.id, queue, 0)}
        >
          <Play className="h-4 w-4" /> เล่นทั้งเซ็ต ({queue.length} เพลง)
        </Button>
      )}
    </section>
  );
}
