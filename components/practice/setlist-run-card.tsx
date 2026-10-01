"use client";

import { useEffect, useMemo, useState } from "react";
import { AudioLines, ListOrdered, Loader2, Play, Square } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { bkkTodayKey, monthBeforeKey } from "@/lib/time";
import {
  orderShowsForPractice,
  setlistQueue,
  type QueueEntry,
  type SetlistShow,
} from "@/lib/practice-setlist";
import { Button } from "@/components/ui/button";
import { FIELD } from "@/components/ui/input";
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
  /** The run in progress, if any: which show, where in its queue, and how long it is. */
  running: { showId: string; index: number; total: number } | null;
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
      <p className="slab px-3 py-2.5 text-[12.5px] text-muted-foreground">
        ซ้อมตามเซ็ตลิสต์: โหลดเซ็ตลิสต์ของงานไม่ได้ — ต้องต่อเน็ต
      </p>
    );
  }
  if (!shows) {
    return (
      <p className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> กำลังโหลดเซ็ตลิสต์ของงาน…
      </p>
    );
  }
  if (shows.length === 0 || !show) return null; // no show with a playable set this month

  return (
    <section aria-label="Setlist" className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="h2">Setlist</h2>
        <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
          <ListOrdered className="h-3.5 w-3.5" aria-hidden /> ซ้อมตามเซ็ตลิสต์ · เล่นต่อเอง
        </span>
      </div>
      <select
        aria-label="เลือกงานที่จะซ้อม"
        value={show.id}
        onChange={(e) => setShowId(e.target.value)}
        className={cn(FIELD, "h-11 w-full min-w-0 px-3 text-base sm:text-sm")}
      >
        {shows.map((s) => (
          <option key={s.id} value={s.id}>
            {whenLabel(s.event_date, today)} · {s.name}
          </option>
        ))}
      </select>

      <ol className="stack">
        {queue.map((q, i) => {
          const active = runningHere?.index === i;
          return (
            <li key={`${q.itemId}-${i}`}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onPlay(show.id, queue, i)}
                className={cn(
                  "slab flex min-h-[50px] w-full items-center gap-3 px-3 text-left text-[14.5px] transition-colors duration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active
                    ? "bg-[linear-gradient(90deg,hsl(var(--primary)/.14),transparent_70%)] font-semibold text-primary-ink shadow-[inset_4px_0_0_hsl(var(--primary)),inset_0_0_0_1px_hsl(var(--border))]"
                    : "hover:bg-muted/40"
                )}
              >
                <span className="num w-5 shrink-0 text-right text-[14px] text-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{q.song.title}</span>
                {active && loadingSongId === q.song.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                ) : active ? (
                  <AudioLines className="h-4 w-4 shrink-0" strokeWidth={2.8} aria-hidden />
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>

      {missing.length > 0 && (
        <p className="px-0.5 text-[12.5px] text-muted-foreground">
          ข้ามเพราะยังไม่มีไฟล์เสียงในคลัง: {missing.join(", ")}
        </p>
      )}

      {/* Shown for ANY run, not only the selected show's: picking another show in
          the dropdown just to look at it must not hide the only stop button for a
          set that keeps auto-advancing underneath. */}
      {running ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-muted-foreground">
            {runningHere
              ? `กำลังเล่นเพลงที่ ${running.index + 1}/${running.total} — จบแล้วเล่นเพลงถัดไปเอง`
              : `กำลังเล่นตามเซ็ตของ “${
                  shows.find((s) => s.id === running.showId)?.name ?? "อีกงาน"
                }” อยู่ (เพลงที่ ${running.index + 1}/${running.total})`}
          </span>
          <Button variant="secondary" onClick={onStop}>
            <Square className="h-3.5 w-3.5" /> หยุดเล่นต่อ
          </Button>
        </div>
      ) : (
        <Button
          className="h-12 w-full"
          disabled={queue.length === 0}
          onClick={() => onPlay(show.id, queue, 0)}
        >
          <Play className="h-4 w-4" /> เล่นทั้งเซ็ต ({queue.length} เพลง)
        </Button>
      )}
    </section>
  );
}
