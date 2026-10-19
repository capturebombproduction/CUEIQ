"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
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
  X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { liveTopic, privateChannel } from "@/lib/realtime";
import { hasLiveSession } from "@/lib/auth-session";
import { writeFailureMessage } from "@/lib/practice-journal-gate";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { bkkTodayKey, monthBeforeKey, TIMING_LABEL, timingMeaning } from "@/lib/time";
import {
  MAX_OVERLAP_SECONDS,
  orderShowsForPractice,
  overlapLead,
  roomQueue,
  setlistQueue,
  type QueueEntry,
  type SetlistShow,
} from "@/lib/practice-setlist";
import { Button } from "@/components/ui/button";
import { FIELD } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PracticeSong, Song } from "@/lib/types";

/** The dropdown's value for the room's own set (a show's is its id). */
const ROOM = "room";
/** The set this room last played from, per device (a convenience: lost = the default). */
const pickKey = (eventId: string) => `cueiq:practice-set:${eventId}`;
function readPick(eventId: string): string | null {
  try {
    return window.localStorage.getItem(pickKey(eventId));
  } catch {
    return null;
  }
}
function writePick(eventId: string, value: string) {
  try {
    window.localStorage.setItem(pickKey(eventId), value);
  } catch {
    /* private window / blocked storage: the default next time */
  }
}

/** The room's own set (พี่ 2026-10-19: "อยากให้สามารถสร้างเองได้") — its practice
 *  list, which the band's members build, order and overlap themselves. */
export type RoomSet = {
  /** the room's list, in order, playable songs only */
  entries: { item: PracticeSong; song: Song }[];
  /** may change it: a member of the band (the practice_songs write gate) */
  canCurate: boolean;
  /** the "เพิ่มเพลง" picker — the player's, so both places add the same way */
  addButton: ReactNode;
  onMove: (itemId: string, dir: -1 | 1) => void;
  onRemove: (itemId: string) => void;
  /** an overlap changed on screen (the card saves it) */
  onOverlap: (itemId: string, seconds: number) => void;
};

// How long the −/+ keys wait for another press before saving: three quick presses
// are one write, not three racing each other to the server.
const SAVE_AFTER_MS = 700;

// The Live Mode notices out right now, per show. ONE channel per show at a time:
// supabase.channel() hands back the channel already open on a topic until
// removeChannel() has finished with it, and subscribe() on that one never calls back -
// so a second save (the next transition, a second after the first) sent nothing, and
// Live Mode kept the old number. A save that lands while a notice is out asks for one
// more: sent on the same channel if it is still up, else on a fresh one once the old
// one is gone.
const liveNotices = new Map<string, { again: boolean }>();

/**
 * Tell a Live Mode screen already open on this show to pull the setlist again — the
 * same "setlist-changed" the setlist builder sends after each save — so it plays the
 * new overlap without a reload. Best-effort: a screen that misses it reads the number
 * on its next load.
 */
function tellLiveMode(eventId: string) {
  const inFlight = liveNotices.get(eventId);
  if (inFlight) {
    inFlight.again = true;
    return;
  }
  const notice = { again: false };
  liveNotices.set(eventId, notice);
  try {
    const supabase = createClient();
    const ch = privateChannel(supabase, liveTopic(eventId));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void Promise.resolve(supabase.removeChannel(ch))
        .catch(() => {})
        .finally(() => {
          liveNotices.delete(eventId);
          if (notice.again) tellLiveMode(eventId);
        });
    };
    const send = () => {
      notice.again = false;
      void ch
        .send({ type: "broadcast", event: "setlist-changed", payload: { at: Date.now() } })
        .finally(() => (notice.again && !closed ? send() : close()));
    };
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") send();
      else close(); // CHANNEL_ERROR / TIMED_OUT / CLOSED
    });
    window.setTimeout(close, 10000); // never left open
  } catch {
    liveNotices.delete(eventId); // see above
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
  eventId,
  groupId,
  room,
  songsById,
  playable,
  running,
  loadingSongId,
  onPlay,
  onStop,
  canEdit,
  onOverlapChange,
}: {
  /** the practice room — its own set runs under this id */
  eventId: string;
  groupId: string;
  room: RoomSet;
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
  // What the dropdown says: a show's id, ROOM, or "" = not chosen here yet (then the
  // set this room last played from, else the next show, else the room's own).
  const [pick, setPick] = useState(() => readPick(eventId) ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(0); // writes in flight
  // The overlap each row holds ON THE SERVER — what a failed write goes back to.
  const savedRef = useRef(new Map<string, number>());
  // Presses waiting out SAVE_AFTER_MS, by row. `showId` null = a row of the room's set.
  const pendingRef = useRef(
    new Map<string, { seconds: number; timer: number; showId: string | null }>()
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
      ordered.forEach((s) =>
        s.setlist_items.forEach((r) =>
          savedRef.current.set(r.id, overlapLead(r.buffer_before_seconds))
        )
      );
      setShows(ordered);
    })();
    return () => {
      alive = false;
    };
  }, [groupId]);

  // The room's own rows: what the server had when they came in (a write that lands
  // moves it on, in write() below).
  room.entries.forEach(({ item }) => {
    if (!savedRef.current.has(item.id)) {
      savedRef.current.set(item.id, overlapLead(-(Number(item.overlap_seconds) || 0)));
    }
  });

  const loading = shows === null && !failed;
  const selected: string | null =
    pick === ROOM
      ? ROOM
      : shows?.some((s) => s.id === pick)
        ? pick
        : loading
          ? null // the shows are still on their way — the pick may be one of them
          : shows?.[0]?.id ?? ROOM;
  const isRoom = selected === ROOM;
  const show = !isRoom && selected ? shows?.find((s) => s.id === selected) ?? null : null;
  const { queue, missing } = useMemo(
    () =>
      isRoom
        ? { queue: roomQueue(room.entries), missing: [] as string[] }
        : show
          ? setlistQueue(show, songsById, playable)
          : { queue: [], missing: [] },
    [isRoom, room.entries, show, songsById, playable]
  );
  const runId = isRoom ? eventId : show?.id ?? null;
  const runningHere = running && runId && running.showId === runId ? running : null;

  function choose(value: string) {
    // Leaving the room's set for a show (or back) ends any editing: who may edit
    // differs between the two, and the pending presses go out first.
    if ((value === ROOM) !== isRoom) {
      flushPending();
      setEditing(false);
    }
    setPick(value);
    writePick(eventId, value);
  }

  // On screen (and into a playing run) at once; the write follows.
  function applyLocal(itemId: string, seconds: number, inRoom: boolean) {
    onOverlapChange(itemId, seconds);
    if (inRoom) {
      room.onOverlap(itemId, seconds);
      return;
    }
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

  async function write(itemId: string, seconds: number, showId: string | null, seq: number) {
    let note: string | null = null;
    try {
      // A show's row: the same column, and the same sign, as the setlist builder's
      // "เล่นซ้อน (วิ)". The room's own: practice_songs.overlap_seconds (0048).
      const { data, error } = showId
        ? await createClient()
            .from("setlist_items")
            .update({ buffer_before_seconds: seconds > 0 ? -seconds : 0 })
            .eq("id", itemId)
            .select("id")
        : await createClient()
            .from("practice_songs")
            .update({ overlap_seconds: seconds })
            .eq("id", itemId)
            .select("id");
      if (error) note = writeFailureMessage(error.code, error.message, await hasLiveSession());
      else if (wroteNothing(data)) note = await noRowsMessage();
      else {
        savedRef.current.set(itemId, seconds);
        if (showId) tellLiveMode(showId);
      }
    } catch (e) {
      note = e instanceof Error ? e.message : "ต่อเน็ตไม่ได้";
    }
    if (note == null) return;
    // Only the newest press puts the number back: one queued behind this write, or
    // still waiting out its pause, decides what the row ends up as.
    if (seqRef.current.get(itemId) === seq && !pendingRef.current.has(itemId)) {
      applyLocal(itemId, savedRef.current.get(itemId) ?? 0, showId == null);
    }
    toast.error("บันทึกเล่นซ้อนไม่สำเร็จ", { description: note });
  }

  function setLead(itemId: string, seconds: number) {
    if (!isRoom && !show) return;
    const n = Math.max(0, Math.min(MAX_OVERLAP_SECONDS, Math.round(seconds)));
    const p = pendingRef.current.get(itemId);
    if (p) window.clearTimeout(p.timer);
    applyLocal(itemId, n, isRoom);
    const timer = window.setTimeout(() => commit(itemId), SAVE_AFTER_MS);
    pendingRef.current.set(itemId, { seconds: n, timer, showId: isRoom || !show ? null : show.id });
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

  if (selected === null || runId === null) {
    return (
      <p className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> กำลังโหลดเซ็ตลิสต์ของงาน…
      </p>
    );
  }

  // The room's set: the band's members order it and set its overlaps. A show's: its
  // editors set the overlaps (they are the show's own, the ones Live Mode plays).
  const canSetOverlaps = isRoom
    ? room.canCurate && room.entries.length > 0
    : canEdit && queue.some((q) => q.adjacent);
  const runName = (id: string) =>
    id === eventId ? "เซ็ตของห้องนี้" : shows?.find((s) => s.id === id)?.name ?? "อีกงาน";

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
        value={selected}
        onChange={(e) => choose(e.target.value)}
        className={cn(FIELD, "h-11 w-full min-w-0 px-3 text-base sm:text-sm")}
      >
        <option value={ROOM}>
          เซ็ตของห้องนี้ (สร้างเอง)
          {room.entries.length > 0 ? ` · ${room.entries.length} เพลง` : ""}
        </option>
        {(shows ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {whenLabel(s.event_date, today)} · {s.name}
          </option>
        ))}
      </select>
      {failed && (
        <p className="px-0.5 text-[12.5px] text-muted-foreground">
          โหลดเซ็ตลิสต์ของงานไม่ได้ — ต้องต่อเน็ต (เซ็ตของห้องนี้ยังเล่นได้)
        </p>
      )}
      {isRoom && room.entries.length === 0 && (
        <p className="slab px-4 py-6 text-center text-sm text-muted-foreground">
          {room.canCurate
            ? "ยังไม่มีเพลงในเซ็ตนี้ — กด “เพิ่มเพลง” แล้วเรียงลำดับ ตั้งเล่นซ้อนได้เอง"
            : "วงนี้ยังไม่ได้สร้างเซ็ตของห้องนี้"}
        </p>
      )}

      <ol className="stack">
        {queue.map((q, i) => {
          const active = runningHere?.index === i;
          return (
            <li key={`${q.itemId}-${i}`}>
              {editing && isRoom ? (
                <div className="slab flex min-h-[50px] w-full items-center gap-1 pl-3 pr-1 text-[14.5px]">
                  <span className="num w-5 shrink-0 text-right text-[14px] text-faint">{i + 1}</span>
                  <span className="ml-2 min-w-0 flex-1 truncate">{q.song.title}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`เลื่อนขึ้น · ${q.song.title}`}
                    disabled={i === 0}
                    onClick={() => room.onMove(q.itemId, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`เลื่อนลง · ${q.song.title}`}
                    disabled={i === queue.length - 1}
                    onClick={() => room.onMove(q.itemId, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`เอาออกจากเซ็ต · ${q.song.title}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => room.onRemove(q.itemId)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              ) : (
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onPlay(runId, queue, i)}
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
              )}
              {/* How this song comes in after the one above (TIMING_LABEL — the setlist
                  builder's own words, พี่ 2026-10-19), under the song it belongs to: it
                  sat between the two, indented under the one above, and read as that
                  one's. The number is the show's, signed: -5 = over the last 5 s of the
                  one above; − / + move along that line (− = more overlap). */}
              {editing && i > 0 ? (
                (q.wait ?? 0) > 0 ? (
                  <p className="py-1.5 pl-8 text-[12px] text-faint">
                    {TIMING_LABEL}: {timingMeaning(q.wait ?? 0)} — แก้ในเซ็ตลิสต์ของงาน
                  </p>
                ) : q.adjacent ? (
                  <div className="space-y-0.5 py-1.5 pl-8">
                    <div className="flex flex-wrap items-center gap-2">
                      <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <span className="text-[12.5px] text-muted-foreground">{TIMING_LABEL}</span>
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label={`เพิ่มเวลาเล่นซ้อน · ${q.song.title}`}
                        disabled={q.overlap >= MAX_OVERLAP_SECONDS}
                        onClick={() => setLead(q.itemId, q.overlap + 1)}
                      >
                        <Minus aria-hidden />
                      </Button>
                      {/* the digits alone wear .num — its face has no Thai, and "วิ"
                          set in it came out as a second, broken digit. Next to bold
                          digits even a Thai "วิ" read as a 5 ("0 วิ" as "05", พี่'s
                          screenshot 2026-10-19): the unit is spelled out, light. */}
                      <output
                        className="min-w-[4.5rem] text-center"
                        aria-label={`เล่นซ้อน ${q.song.title} ${q.overlap} วินาที`}
                      >
                        <span className="num text-[15px]">{q.overlap > 0 ? `-${q.overlap}` : "0"}</span>{" "}
                        <span className="text-[12px] font-normal text-muted-foreground">วินาที</span>
                      </output>
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label={`ลดเวลาเล่นซ้อน · ${q.song.title}`}
                        disabled={q.overlap <= 0}
                        onClick={() => setLead(q.itemId, q.overlap - 1)}
                      >
                        <Plus aria-hidden />
                      </Button>
                    </div>
                    <p className="pl-5 text-[12px] text-muted-foreground">
                      {timingMeaning(-q.overlap)}
                    </p>
                  </div>
                ) : (
                  <p className="py-1.5 pl-8 text-[12px] text-faint">
                    มี MC หรือช่วงอื่นคั่นในงาน — เริ่มหลังเพลงก่อนหน้าจบ
                  </p>
                )
              ) : q.overlap > 0 ? (
                <p className="flex items-center gap-1.5 py-1 pl-8 text-[12.5px] text-muted-foreground">
                  <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                  เล่นซ้อนเพลงก่อนหน้า <span className="num text-foreground">{q.overlap}</span> วิ
                </p>
              ) : null}
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
                : isRoom
                  ? "บันทึกลงเซ็ตของห้องนี้ — ไม่กระทบเซ็ตลิสต์ของงานจริง"
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
            <Pencil aria-hidden /> {isRoom ? "แก้เซ็ต · เรียง / เล่นซ้อน" : "ตั้งเล่นซ้อน"}
          </Button>
        ))}

      {/* the room's set grows from the library, the same picker the Queue uses */}
      {isRoom && room.canCurate && <div className="flex justify-end">{room.addButton}</div>}

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
              : `กำลังเล่นตามเซ็ตของ “${runName(running.showId)}” อยู่ (เพลงที่ ${
                  running.index + 1
                }/${running.total})`}
          </span>
          <Button variant="secondary" onClick={onStop}>
            <Square className="h-3.5 w-3.5" /> หยุดเล่นต่อ
          </Button>
        </div>
      ) : (
        <Button
          className="h-12 w-full"
          disabled={queue.length === 0}
          onClick={() => onPlay(runId, queue, 0)}
        >
          <Play className="h-4 w-4" /> เล่นทั้งเซ็ต ({queue.length} เพลง)
        </Button>
      )}
    </section>
  );
}
