"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Play,
  Pause,
  Loader2,
  Gauge,
  Volume2,
  SkipBack,
  Search,
  MapPin,
  Plus,
  Repeat,
  Pencil,
  X,
  ListMusic,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { getSongBlob } from "@/lib/song-cache";
import { PracticeAudioEngine } from "@/lib/practice-audio";
import { detectBeats } from "@/lib/bpm-detect";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BreakTimer } from "@/components/practice/break-timer";
import { Metronome } from "@/components/practice/metronome";
import { cn } from "@/lib/utils";
import { MARKER_PRESETS, type Song, type SongMarker, type PracticeSong } from "@/lib/types";

// Speed presets — slowing down for practice. The engine (SoundTouchJS) time-
// stretches with pitch preserved, so 0.5x stays in the same key, just slower —
// and it does so identically across browsers, including iOS Safari.
const SPEEDS = [1, 0.75, 0.5] as const;
// only auto-log a song as "practiced" once it's been played at least this long
const RUN_LOG_THRESHOLD = 20;

function mmss(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Practice Mode player — Slices 1 + 2 (+ auto-log from Slice 3). The room has a
 * curated PRACTICE LIST (a subset of the band's library) that ANY band member can
 * manage — they practice on their own / at home; play a listed song slowed down
 * (1.0 / 0.75 / 0.5, pitch preserved) + scrubber; jump
 * between section markers (per-song, reusable; Ar manages); loop a section with
 * Mark In→Mark Out; run a break timer. Songs played long enough are auto-logged to
 * practice_runs so the journal can show "what we practiced today". Single device,
 * online: audio streams from R2 on demand. For a timed run-through use Live Mode.
 */
export function PracticePlayer({
  eventId,
  currentUserId,
  songs,
  items,
  setItems,
  markersBySong,
  canManage,
  onRunLogged,
}: {
  eventId: string;
  currentUserId: string;
  songs: Song[]; // the band's full library — the pool the "add song" picker offers
  // The practice list lives in PracticeMode (the parent) so it SURVIVES a tab switch
  // — the player unmounts when you open the journal, and local state would reset to
  // a stale server prop, dropping songs you just added (and then the unique key
  // would reject re-adding them). Owning it above the Tabs fixes that.
  items: PracticeSong[];
  setItems: Dispatch<SetStateAction<PracticeSong[]>>;
  markersBySong: Record<string, SongMarker[]>;
  canManage: boolean; // Ar/admin — gates only the metronome's "save BPM to song"
  // (the list + section markers are member-writable; BPM lives on the guarded songs table)
  onRunLogged?: () => void;
}) {
  const confirm = useConfirm();
  const songsById = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);
  // library songs that actually have audio — the pool the picker offers
  const library = useMemo(() => songs.filter((s) => !!s.audio_path), [songs]);
  const listedIds = useMemo(() => new Set(items.map((i) => i.song_id)), [items]);
  // resolve each list row to a playable song (skip songs that lost their audio)
  const practiceSongs = useMemo(
    () =>
      items
        .map((item) => ({ item, song: songsById.get(item.song_id) }))
        .filter(
          (x): x is { item: PracticeSong; song: Song } =>
            !!x.song && !!x.song.audio_path
        ),
    [items, songsById]
  );

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return practiceSongs;
    return practiceSongs.filter((x) => x.song.title.toLowerCase().includes(q));
  }, [practiceSongs, query]);

  const engineRef = useRef<PracticeAudioEngine | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [vol, setVol] = useState(100);
  // true while the engine decodes a song for the first slow-down (stretch backend)
  const [preparing, setPreparing] = useState(false);

  const [markers, setMarkers] = useState<Record<string, SongMarker[]>>(markersBySong);
  const [editMarkers, setEditMarkers] = useState(false);
  const [customLabel, setCustomLabel] = useState("");

  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const loopRef = useRef<{ a: number | null; b: number | null; on: boolean }>({
    a: null,
    b: null,
    on: false,
  });
  loopRef.current = { a: loopA, b: loopB, on: loopOn };

  const current = currentId ? songsById.get(currentId) ?? null : null;
  const curMarkers = useMemo(
    () =>
      (currentId ? markers[currentId] ?? [] : [])
        .slice()
        .sort((a, b) => a.position_seconds - b.position_seconds),
    [markers, currentId]
  );

  // --- auto-log accounting (refs so the stable audio listeners can mutate them) ---
  const runRef = useRef<{
    song: Song | null;
    accum: number; // played seconds accumulated
    startedAt: number | null; // ms when the current play burst began
    speed: number;
  }>({ song: null, accum: 0, startedAt: null, speed: 1 });
  runRef.current.speed = speed;

  function flushRun() {
    const r = runRef.current;
    if (r.startedAt != null) {
      r.accum += (Date.now() - r.startedAt) / 1000;
      r.startedAt = null;
    }
    const song = r.song;
    const secs = Math.round(r.accum);
    r.song = null;
    r.accum = 0;
    if (!song || secs < RUN_LOG_THRESHOLD) return;
    const supabase = createClient();
    supabase
      .from("practice_runs")
      .insert({
        tenant_id: song.tenant_id,
        group_id: song.group_id,
        event_id: eventId,
        song_id: song.id,
        song_title: song.title,
        seconds: secs,
        last_speed: r.speed,
        created_by: currentUserId,
      })
      .then(() => onRunLogged?.());
  }

  // one SoundTouch engine for the whole session (created once; talks to Web Audio)
  useEffect(() => {
    const engine = new PracticeAudioEngine();
    engineRef.current = engine;
    engine.onDuration = (d) => setDur(d);
    engine.onTime = (t) => {
      setCur(t);
      const { a: la, b: lb, on } = loopRef.current;
      if (on && la != null && lb != null && lb > la && t >= lb) engine.seek(la);
    };
    engine.onPlayingChange = (p) => {
      setPlaying(p);
      const r = runRef.current;
      if (p) {
        if (r.startedAt == null) r.startedAt = Date.now();
      } else if (r.startedAt != null) {
        r.accum += (Date.now() - r.startedAt) / 1000;
        r.startedAt = null;
      }
    };
    engine.onPreparing = (p) => setPreparing(p);
    return () => {
      flushRun(); // log whatever was playing when we leave
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setVolume(vol / 100);
  }, [vol]);

  const wakeRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!playing) {
      wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
      return;
    }
    navigator.wakeLock
      ?.request("screen")
      .then((wl) => {
        wl.addEventListener("release", () => {
          if (wakeRef.current === wl) wakeRef.current = null;
        });
        wakeRef.current = wl;
      })
      .catch(() => {});
    return () => {
      wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
    };
  }, [playing]);

  async function selectSong(song: Song) {
    const engine = engineRef.current;
    if (!engine || !song.audio_path) return;
    engine.unlock(); // sync, inside the tap — unlocks audio on iOS Safari
    if (song.id === currentId) {
      engine.toggle();
      return;
    }
    flushRun(); // finalize the previous song's practice time
    setLoadingId(song.id);
    try {
      // Cache-first: a prefetched song opens instantly; otherwise download once
      // (and the cache keeps it for next time).
      const blob = await getSongBlob(song.audio_path);
      await engine.load(blob); // decode happens here, inside the spinner
      setCurrentId(song.id);
      runRef.current.song = song; // start accounting for the new song
      runRef.current.accum = 0;
      runRef.current.startedAt = null;
      setLoopA(null);
      setLoopB(null);
      setLoopOn(false);
      setEditMarkers(false);
      await engine.play(); // engine already carries the current speed (tempo)
    } catch (err) {
      toast.error("โหลดเพลงไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoadingId(null);
    }
  }

  function togglePlay() {
    const engine = engineRef.current;
    if (!engine || !currentId) return;
    engine.unlock();
    engine.toggle();
  }

  function seek(to: number) {
    engineRef.current?.seek(to);
  }

  function jumpTo(pos: number) {
    const engine = engineRef.current;
    if (!engine) return;
    engine.unlock();
    engine.seek(pos);
    if (!engine.playing) void engine.play();
  }

  async function addMarker(label: string) {
    const engine = engineRef.current;
    if (!current || !engine) return;
    const pos = engine.currentTime;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("song_markers")
      .insert({
        tenant_id: current.tenant_id,
        group_id: current.group_id,
        song_id: current.id,
        label,
        position_seconds: pos,
        sort_order: curMarkers.length,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มมาร์คไม่สำเร็จ", { description: error?.message });
      return;
    }
    const m = data as SongMarker;
    setMarkers((prev) => ({ ...prev, [current.id]: [...(prev[current.id] ?? []), m] }));
    setCustomLabel("");
    toast.success(`มาร์ค “${label}” ที่ ${mmss(pos)}`);
  }

  async function deleteMarker(id: string) {
    if (!current) return;
    setMarkers((prev) => ({
      ...prev,
      [current.id]: (prev[current.id] ?? []).filter((m) => m.id !== id),
    }));
    const supabase = createClient();
    await supabase.from("song_markers").delete().eq("id", id);
  }

  // wipe every mark on the current song at once (optimistic, reverts on error)
  async function clearMarkers() {
    if (!current) return;
    const list = markers[current.id] ?? [];
    if (list.length === 0) return;
    const ok = await confirm({
      title: "ล้างท่อนทั้งหมด?",
      description: `จะลบจุดท่อนทั้ง ${list.length} จุดของเพลงนี้`,
      confirmText: "ล้างทั้งหมด",
    });
    if (!ok) return;
    setMarkers((prev) => ({ ...prev, [current.id]: [] }));
    setEditMarkers(false);
    const { error } = await createClient()
      .from("song_markers")
      .delete()
      .in(
        "id",
        list.map((m) => m.id)
      );
    if (error) {
      toast.error("ล้างท่อนไม่สำเร็จ", { description: error.message });
      setMarkers((prev) => ({ ...prev, [current.id]: list })); // revert
    } else {
      toast.success("ล้างท่อนทั้งหมดแล้ว");
    }
  }

  function setA() {
    const engine = engineRef.current;
    if (!engine) return;
    const t = engine.currentTime;
    setLoopA(t);
    if (loopB != null && t >= loopB) setLoopB(null);
  }
  function setB() {
    const engine = engineRef.current;
    if (!engine) return;
    const t = engine.currentTime;
    if (loopA != null && t <= loopA) {
      toast.error("Mark Out ต้องอยู่หลัง Mark In");
      return;
    }
    setLoopB(t);
    setLoopOn(true);
  }
  function clearLoop() {
    setLoopA(null);
    setLoopB(null);
    setLoopOn(false);
  }

  // --- practice list: any band member adds a library song / takes one out (RLS =
  // can_view_group, so members curate their own practice list — see practice_songs) ---
  async function addSong(song: Song) {
    const sort = items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 1;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("practice_songs")
      .insert({
        tenant_id: song.tenant_id,
        group_id: song.group_id,
        event_id: eventId,
        song_id: song.id,
        sort_order: sort,
        created_by: currentUserId,
      })
      .select("*")
      .single();
    if (error || !data) {
      // 23505 = already in the list (unique event_id+song_id) — not a real failure
      if (error?.code === "23505") {
        toast.info("เพลงนี้อยู่ในลิสต์ซ้อมอยู่แล้ว");
      } else {
        toast.error("เพิ่มเพลงไม่สำเร็จ", { description: error?.message });
      }
      return;
    }
    setItems((prev) =>
      prev.some((i) => i.id === (data as PracticeSong).id)
        ? prev
        : [...prev, data as PracticeSong]
    );
    toast.success(`เพิ่ม “${song.title}” เข้าลิสต์ซ้อม`);
  }

  async function removeSong(itemId: string) {
    const snapshot = items;
    const it = snapshot.find((i) => i.id === itemId);
    const title = it ? songsById.get(it.song_id)?.title : undefined;
    const ok = await confirm({
      title: "เอาเพลงออกจากลิสต์ซ้อม?",
      description: title ? `“${title}” จะถูกเอาออกจากลิสต์ซ้อม` : "เพลงนี้จะถูกเอาออกจากลิสต์ซ้อม",
      confirmText: "เอาออก",
    });
    if (!ok) return;
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    const { error } = await createClient()
      .from("practice_songs")
      .delete()
      .eq("id", itemId);
    if (error) {
      toast.error("เอาเพลงออกไม่สำเร็จ", { description: error.message });
      setItems(snapshot);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-end gap-2">
        <Metronome
          song={current}
          canManage={canManage}
          playing={playing}
          position={cur}
          speed={speed}
          onDetectBeats={async () => {
            const buf = await engineRef.current?.getBuffer();
            return buf ? detectBeats(buf) : null;
          }}
        />
        <BreakTimer />
      </div>

      {/* Now playing + transport */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        {current ? (
          <>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="min-w-0 truncate font-semibold">{current.title}</p>
              {speed !== 1 && (
                <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                  ช้า {speed}× · คีย์เดิม
                </span>
              )}
            </div>

            <input
              type="range"
              min={0}
              max={dur || 0}
              step={0.1}
              value={cur}
              onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-[var(--primary)]"
            />
            <div className="mb-3 flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{mmss(cur)}</span>
              <span>{mmss(dur)}</span>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => seek(0)} title="กลับไปต้นเพลง">
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button size="icon" className="h-11 w-11" onClick={togglePlay}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </Button>

              <div className="ml-1 flex items-center gap-1">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    disabled={preparing}
                    onClick={() => {
                      setSpeed(s);
                      engineRef.current?.unlock();
                      engineRef.current?.setTempo(s);
                    }}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                      speed === s
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    )}
                  >
                    {s}×
                  </button>
                ))}
                {preparing && (
                  <Loader2 className="ml-0.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>

            </div>

            {/* song volume — always visible (separate from the metronome's volume) */}
            <div className="mt-3 flex items-center gap-2">
              <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="w-16 shrink-0 text-xs text-muted-foreground">เสียงเพลง</span>
              <input
                type="range"
                min={0}
                max={100}
                value={vol}
                onChange={(e) => setVol(Number(e.target.value))}
                className="w-full accent-[var(--primary)]"
              />
            </div>

            {/* A-B loop */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Repeat className="h-3.5 w-3.5" /> วนท่อน
              </span>
              <Button variant={loopA != null ? "secondary" : "outline"} size="sm" onClick={setA}>
                Mark In{loopA != null ? ` · ${mmss(loopA)}` : ""}
              </Button>
              <Button variant={loopB != null ? "secondary" : "outline"} size="sm" onClick={setB}>
                Mark Out{loopB != null ? ` · ${mmss(loopB)}` : ""}
              </Button>
              <Button
                variant={loopOn ? "default" : "outline"}
                size="sm"
                disabled={loopA == null || loopB == null}
                onClick={() => setLoopOn((v) => !v)}
              >
                <Repeat className="h-4 w-4" /> {loopOn ? "กำลังวน" : "วน"}
              </Button>
              {(loopA != null || loopB != null) && (
                <Button variant="ghost" size="sm" onClick={clearLoop}>
                  ล้าง
                </Button>
              )}
            </div>

            {/* markers */}
            <div className="mt-3 border-t pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" /> ท่อนเพลง
                </span>
                {curMarkers.length > 0 && (
                  <div className="flex items-center gap-3">
                    {editMarkers && (
                      <button
                        onClick={clearMarkers}
                        className="flex items-center gap-1 text-xs text-destructive hover:underline"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> ล้างทั้งหมด
                      </button>
                    )}
                    <button
                      onClick={() => setEditMarkers((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" /> {editMarkers ? "เสร็จ" : "แก้ไข"}
                    </button>
                  </div>
                )}
              </div>

              {curMarkers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  ยังไม่มีท่อน — เพิ่มจากปุ่มด้านล่าง
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {curMarkers.map((m) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center overflow-hidden rounded-full border bg-muted/50"
                    >
                      <button
                        onClick={() => jumpTo(m.position_seconds)}
                        className="px-2.5 py-1 text-xs font-medium hover:bg-muted"
                      >
                        {m.label}
                        <span className="ml-1 tabular-nums text-muted-foreground">
                          {mmss(m.position_seconds)}
                        </span>
                      </button>
                      {editMarkers && (
                        <button
                          onClick={() => deleteMarker(m.id)}
                          className="border-l px-1.5 py-1 text-destructive hover:bg-destructive/10"
                          title="ลบท่อนนี้"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-2.5 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {MARKER_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() => addMarker(p)}
                        className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
                      >
                        <Plus className="mr-0.5 inline h-3 w-3" />
                        {p}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                      placeholder={`ชื่อท่อนเอง แล้วเพิ่มที่ ${mmss(cur)}`}
                      className="h-9"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && customLabel.trim()) addMarker(customLabel.trim());
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!customLabel.trim()}
                      onClick={() => addMarker(customLabel.trim())}
                    >
                      <Plus className="h-4 w-4" /> เพิ่ม
                    </Button>
                  </div>
                </div>
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่ได้เลือกเพลง — แตะเพลงด้านล่างเพื่อเริ่มซ้อม
          </p>
        )}
      </div>

      {/* Practice list — only the songs chosen for this room. Any band member
          curates it (add from library / take out) and plays. For a timed run-through
          of the whole show, use Live Mode instead. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ListMusic className="h-4 w-4" /> ลิสต์ซ้อม
            {practiceSongs.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                · {practiceSongs.length} เพลง
              </span>
            )}
          </span>
          <AddPracticeSongDialog
            library={library}
            listedIds={listedIds}
            onAdd={addSong}
          />
        </div>

        {practiceSongs.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีเพลงในลิสต์ซ้อม
            <br />
            กด “เพิ่มเพลง” เพื่อเลือกเพลงจากคลังมาซ้อม
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาเพลงในลิสต์ซ้อม..."
                className="pl-8"
              />
            </div>

            <div className="divide-y rounded-lg border">
              {filtered.map(({ item, song: s }) => {
                const active = s.id === currentId;
                const loading = s.id === loadingId;
                const mCount = (markers[s.id] ?? []).length;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 transition-colors",
                      active ? "bg-primary/10" : "hover:bg-muted/50"
                    )}
                  >
                    <button
                      onClick={() => selectSong(s)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : active && playing ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{s.title}</span>
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          {s.duration_seconds > 0 && (
                            <span>Duration {mmss(s.duration_seconds)}</span>
                          )}
                          {mCount > 0 && (
                            <span>
                              {s.duration_seconds > 0 ? "· " : ""}
                              {mCount} Mark{mCount > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={() => removeSong(item.id)}
                      title="เอาออกจากลิสต์ซ้อม"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  ไม่พบเพลงที่ค้นหา
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Pick a library song (with audio, not already in the list) to add to the practice
// list. Stays open after a pick so several songs can be added in one go.
function AddPracticeSongDialog({
  library,
  listedIds,
  onAdd,
}: {
  library: Song[];
  listedIds: Set<string>;
  onAdd: (song: Song) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const available = useMemo(
    () => library.filter((s) => !listedIds.has(s.id)),
    [library, listedIds]
  );
  const filtered = available.filter((s) =>
    s.title.toLowerCase().includes(q.trim().toLowerCase())
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-4 w-4" /> เพิ่มเพลง
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>เพิ่มเพลงเข้าลิสต์ซ้อม</DialogTitle>
        </DialogHeader>
        {library.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่มีเพลงที่มีไฟล์เสียงในคลังของวงนี้ — อัปโหลดในคลังเพลงก่อน แล้วกลับมาเพิ่มได้
          </p>
        ) : available.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            เพิ่มครบทุกเพลงในคลังแล้ว
          </p>
        ) : (
          <div className="space-y-2">
            <Input
              autoFocus
              placeholder="ค้นหาชื่อเพลง…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="max-h-72 space-y-1 overflow-auto">
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">ไม่พบเพลง</p>
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    onClick={() => {
                      onAdd(s);
                      setQ("");
                    }}
                  >
                    <span className="font-medium">{s.title}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {s.duration_seconds ? mmss(s.duration_seconds) : "—"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
