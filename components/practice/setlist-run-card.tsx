"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  CornerDownRight,
  ListOrdered,
  Loader2,
  Minus,
  Pencil,
  Play,
  Plus,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { liveTopic, privateChannel } from "@/lib/realtime";
import { hasLiveSession } from "@/lib/auth-session";
import { writeFailureMessage } from "@/lib/practice-journal-gate";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { bkkTodayKey, monthBeforeKey } from "@/lib/time";
import {
  MAX_OVERLAP_SECONDS,
  orderShowsForPractice,
  overlapLead,
  setlistQueue,
  type QueueEntry,
  type SetlistShow,
} from "@/lib/practice-setlist";
import { Button } from "@/components/ui/button";
import { FIELD } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Song } from "@/lib/types";

// How long the −/+ keys wait for another press before saving: three quick presses
// are one write, not three racing each other to the server.
const SAVE_AFTER_MS = 700;

/**
 * Tell a Live Mode screen already open on this show to pull the setlist again — the
 * same "setlist-changed" the setlist builder sends after each save — so it plays the
 * new overlap without a reload. Best-effort: a screen that misses it reads the number
 * on its next load.
 */
function tellLiveMode(eventId: string) {
  try {
    const supabase = createClient();
    const ch = privateChannel(supabase, liveTopic(eventId));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void supabase.removeChannel(ch);
    };
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void ch
          .send({ type: "broadcast", event: "setlist-changed", payload: { at: Date.now() } })
          .finally(close);
      } else {
        close(); // CHANNEL_ERROR / TIMED_OUT / CLOSED
      }
    });
    window.setTimeout(close, 10000); // never left open
  } catch {
    /* see above */
  }
}

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
 * the last one ends — or, where the show has a "เล่นซ้อน", that many seconds
 * before it ends, the way Live Mode will play it. Loads its own shows (this band,
 * the last month onward) with the page's own client, so the web page and the
 * desktop app get it without either loader changing; offline it just says it
 * can't load. Playback, and the auto-advance, live in PracticePlayer — this card
 * picks, displays, and lets the band's editors set the overlaps (saved to the
 * show's own setlist: one number for the rehearsal and the show, พี่ 2026-10-07).
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
  canEdit,
  onOverlapChange,
}: {
  groupId: string;
  songsById: Map<string, Song>;
  playable: (s: Song) => boolean;
  /** The run in progress, if any: which show, where in its queue, how long it is,
   *  and how early its next song comes in. */
  running: { showId: string; index: number; total: number; nextOverlap: number } | null;
  loadingSongId: string | null;
  onPlay: (showId: string, queue: QueueEntry[], index: number) => void;
  onStop: () => void;
  /** may edit the band's shows (admin / the band's Ar) — the overlaps are theirs */
  canEdit: boolean;
  /** an overlap changed here — so a run already playing hears it */
  onOverlapChange: (itemId: string, seconds: number) => void;
}) {
  const today = bkkTodayKey();
  const [shows, setShows] = useState<SetlistShow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showId, setShowId] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(0); // writes in flight
  // The overlap each row holds ON THE SERVER — what a failed write goes back to.
  const savedRef = useRef(new Map<string, number>());
  // Presses waiting out SAVE_AFTER_MS, by row.
  const pendingRef = useRef(
    new Map<string, { seconds: number; timer: number; showId: string }>()
  );
  // Per row, the writes go out one after another — in the order pressed, never two
  // racing to the server on venue wifi — and only the newest may put a number back.
  const chainRef = useRef(new Map<string, Promise<void>>());
  const seqRef = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await createClient()
        .from("events")
        .select(
          "id, name, event_date, setlist_items(id, title, kind, song_id, sort_order, buffer_before_seconds)"
        )
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
      savedRef.current = new Map(
        ordered.flatMap((s) =>
          s.setlist_items.map((r) => [r.id, overlapLead(r.buffer_before_seconds)] as const)
        )
      );
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

  // On screen (and into a playing run) at once; the write follows.
  function applyLocal(itemId: string, seconds: number) {
    setShows((prev) =>
      prev
        ? prev.map((s) => ({
            ...s,
            setlist_items: s.setlist_items.map((r) =>
              r.id === itemId ? { ...r, buffer_before_seconds: seconds > 0 ? -seconds : 0 } : r
            ),
          }))
        : prev
    );
    onOverlapChange(itemId, seconds);
  }

  function commit(itemId: string) {
    const p = pendingRef.current.get(itemId);
    if (!p) return;
    pendingRef.current.delete(itemId);
    window.clearTimeout(p.timer);
    const seq = (seqRef.current.get(itemId) ?? 0) + 1;
    seqRef.current.set(itemId, seq);
    setSaving((n) => n + 1);
    const queued = (chainRef.current.get(itemId) ?? Promise.resolve())
      .then(() => write(itemId, p.seconds, p.showId, seq))
      .finally(() => setSaving((n) => n - 1));
    chainRef.current.set(itemId, queued);
  }

  async function write(itemId: string, seconds: number, showId: string, seq: number) {
    let note: string | null = null;
    try {
      // the same column, and the same sign, as the setlist builder's "เล่นซ้อน (วิ)"
      const { data, error } = await createClient()
        .from("setlist_items")
        .update({ buffer_before_seconds: seconds > 0 ? -seconds : 0 })
        .eq("id", itemId)
        .select("id");
      if (error) note = writeFailureMessage(error.code, error.message, await hasLiveSession());
      else if (wroteNothing(data)) note = await noRowsMessage();
      else {
        savedRef.current.set(itemId, seconds);
        tellLiveMode(showId);
      }
    } catch (e) {
      note = e instanceof Error ? e.message : "ต่อเน็ตไม่ได้";
    }
    if (note == null) return;
    // Only the newest press puts the number back: one queued behind this write, or
    // still waiting out its pause, decides what the row ends up as.
    if (seqRef.current.get(itemId) === seq && !pendingRef.current.has(itemId)) {
      applyLocal(itemId, savedRef.current.get(itemId) ?? 0);
    }
    toast.error("บันทึกเล่นซ้อนไม่สำเร็จ", { description: note });
  }

  function setLead(itemId: string, seconds: number) {
    if (!show) return;
    const n = Math.max(0, Math.min(MAX_OVERLAP_SECONDS, Math.round(seconds)));
    const p = pendingRef.current.get(itemId);
    if (p) window.clearTimeout(p.timer);
    applyLocal(itemId, n);
    const timer = window.setTimeout(() => commit(itemId), SAVE_AFTER_MS);
    pendingRef.current.set(itemId, { seconds: n, timer, showId: show.id });
  }

  function flushPending() {
    Array.from(pendingRef.current.keys()).forEach((id) => commit(id));
  }

  // Leaving the room inside the wait must not drop the last press.
  useEffect(
    () => () => {
      Array.from(pendingRef.current.keys()).forEach((id) => commit(id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
    []
  );

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

  const canSetOverlaps = canEdit && queue.some((q) => q.adjacent);

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
              {/* The overlap INTO this song sits between it and the one above:
                  "↳ ซ้อน 5 วิ" = it comes in 5 s before that one ends. */}
              {editing && i > 0 ? (
                q.adjacent ? (
                  <div className="flex items-center gap-2 py-1.5 pl-8">
                    <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <span className="text-[12.5px] text-muted-foreground">เข้าก่อนจบ</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      aria-label={`ลดเวลาเล่นซ้อน · ${q.song.title}`}
                      disabled={q.overlap <= 0}
                      onClick={() => setLead(q.itemId, q.overlap - 1)}
                    >
                      <Minus aria-hidden />
                    </Button>
                    {/* the digit alone wears .num — its face has no Thai, and "วิ"
                        set in it came out as a second, broken digit */}
                    <output
                      className="min-w-[3.25rem] text-center text-[14px]"
                      aria-label={`เล่นซ้อน ${q.song.title} ${q.overlap} วินาที`}
                    >
                      <span className="num text-[15px]">{q.overlap}</span> วิ
                    </output>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      aria-label={`เพิ่มเวลาเล่นซ้อน · ${q.song.title}`}
                      disabled={q.overlap >= MAX_OVERLAP_SECONDS}
                      onClick={() => setLead(q.itemId, q.overlap + 1)}
                    >
                      <Plus aria-hidden />
                    </Button>
                  </div>
                ) : (
                  <p className="py-1 pl-8 text-[12px] text-faint">
                    มี MC หรือช่วงอื่นคั่นในงาน — เล่นหลังเพลงบนจบ
                  </p>
                )
              ) : q.overlap > 0 ? (
                <p className="flex items-center gap-1.5 py-1 pl-8 text-[12.5px] text-muted-foreground">
                  <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                  ซ้อน <span className="num text-foreground">{q.overlap}</span> วิ
                </p>
              ) : null}
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

      {/* while editing the bar stays, even on a show with nothing to overlap —
          picking one in the dropdown must not hide the only way out (editing is
          only ever entered through canSetOverlaps, which is the editor's gate) */}
      {(editing || canSetOverlaps) &&
        (editing ? (
          <div className="slab flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
              {saving > 0
                ? "กำลังบันทึก…"
                : "บันทึกลงเซ็ตลิสต์ของงานนี้ — Live Mode ใช้ค่าเดียวกัน"}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                flushPending();
                setEditing(false);
              }}
            >
              <Check aria-hidden /> เสร็จ
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden /> ตั้งเล่นซ้อน
          </Button>
        ))}

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
              ? `กำลังเล่นเพลงที่ ${running.index + 1}/${running.total} — ${
                  running.nextOverlap > 0
                    ? `เพลงถัดไปเข้าก่อนจบ ${running.nextOverlap} วิ`
                    : "จบแล้วเล่นเพลงถัดไปเอง"
                }`
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
