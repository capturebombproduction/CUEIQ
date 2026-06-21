"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { downloadEventAudio } from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BreakTimer } from "@/components/practice/break-timer";
import { cn } from "@/lib/utils";
import { MARKER_PRESETS, type Song, type SongMarker } from "@/lib/types";

// Speed presets — slowing down for practice. Pitch is preserved (see preservesPitch
// below) so 0.5x stays in the same key, just slower.
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
 * Practice Mode player — Slices 1 + 2 (+ auto-log from Slice 3). Pick any library
 * song that has audio and play it slowed down (1.0 / 0.75 / 0.5, pitch preserved) +
 * scrubber; jump between section markers (per-song, reusable; Ar manages); loop a
 * section A→B; run a break timer. Songs played long enough are auto-logged to
 * practice_runs so the journal can show "what we practiced today". Single device,
 * online: audio streams from R2 on demand.
 */
export function PracticePlayer({
  eventId,
  currentUserId,
  songs,
  markersBySong,
  canManage,
  onRunLogged,
}: {
  eventId: string;
  currentUserId: string;
  songs: Song[];
  markersBySong: Record<string, SongMarker[]>;
  canManage: boolean;
  onRunLogged?: () => void;
}) {
  const playable = useMemo(() => songs.filter((s) => !!s.audio_path), [songs]);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return playable;
    return playable.filter((s) => s.title.toLowerCase().includes(q));
  }, [playable, query]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [vol, setVol] = useState(100);

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

  const current = playable.find((s) => s.id === currentId) ?? null;
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

  // one audio element for the whole session
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    audioRef.current = a;
    const onTime = () => {
      setCur(a.currentTime);
      const { a: la, b: lb, on } = loopRef.current;
      if (on && la != null && lb != null && lb > la && a.currentTime >= lb) {
        a.currentTime = la;
      }
    };
    const onMeta = () => setDur(a.duration);
    const onPlay = () => {
      setPlaying(true);
      if (runRef.current.startedAt == null) runRef.current.startedAt = Date.now();
    };
    const stopAccum = () => {
      const r = runRef.current;
      if (r.startedAt != null) {
        r.accum += (Date.now() - r.startedAt) / 1000;
        r.startedAt = null;
      }
    };
    const onPause = () => {
      setPlaying(false);
      stopAccum();
    };
    const onEnd = () => {
      setPlaying(false);
      stopAccum();
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      flushRun(); // log whatever was playing when we leave
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.src = "";
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = speed;
    a.preservesPitch = true;
    // @ts-expect-error vendor-prefixed fallback (older WebKit/Firefox)
    a.webkitPreservesPitch = true;
    // @ts-expect-error vendor-prefixed fallback (older Firefox)
    a.mozPreservesPitch = true;
  }, [speed, currentId]);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = Math.min(1, Math.max(0, vol / 100));
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
    const a = audioRef.current;
    if (!a || !song.audio_path) return;
    if (song.id === currentId) {
      if (a.paused) a.play().catch(() => {});
      else a.pause();
      return;
    }
    flushRun(); // finalize the previous song's practice time
    setLoadingId(song.id);
    try {
      const blob = await downloadEventAudio(song.audio_path);
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      a.src = url;
      a.currentTime = 0;
      setCur(0);
      setDur(0);
      setCurrentId(song.id);
      runRef.current.song = song; // start accounting for the new song
      runRef.current.accum = 0;
      runRef.current.startedAt = null;
      setLoopA(null);
      setLoopB(null);
      setLoopOn(false);
      setEditMarkers(false);
      a.playbackRate = speed;
      a.preservesPitch = true;
      await a.play().catch(() => {});
    } catch (err) {
      toast.error("โหลดเพลงไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoadingId(null);
    }
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a || !currentId) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function seek(to: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.min(dur || 0, Math.max(0, to));
    setCur(a.currentTime);
  }

  function jumpTo(pos: number) {
    seek(pos);
    const a = audioRef.current;
    if (a && a.paused) a.play().catch(() => {});
  }

  async function addMarker(label: string) {
    const a = audioRef.current;
    if (!current || !a || !canManage) return;
    const pos = a.currentTime;
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
    if (!current || !canManage) return;
    setMarkers((prev) => ({
      ...prev,
      [current.id]: (prev[current.id] ?? []).filter((m) => m.id !== id),
    }));
    const supabase = createClient();
    await supabase.from("song_markers").delete().eq("id", id);
  }

  function setA() {
    const a = audioRef.current;
    if (!a) return;
    setLoopA(a.currentTime);
    if (loopB != null && a.currentTime >= loopB) setLoopB(null);
  }
  function setB() {
    const a = audioRef.current;
    if (!a) return;
    if (loopA != null && a.currentTime <= loopA) {
      toast.error("จุด B ต้องอยู่หลังจุด A");
      return;
    }
    setLoopB(a.currentTime);
    setLoopOn(true);
  }
  function clearLoop() {
    setLoopA(null);
    setLoopB(null);
    setLoopOn(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
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
                    onClick={() => setSpeed(s)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      speed === s
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    )}
                  >
                    {s}×
                  </button>
                ))}
              </div>

              <div className="ml-auto hidden items-center gap-2 sm:flex">
                <Volume2 className="h-4 w-4 text-muted-foreground" />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={vol}
                  onChange={(e) => setVol(Number(e.target.value))}
                  className="w-24 accent-[var(--primary)]"
                />
              </div>
            </div>

            {/* A-B loop */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Repeat className="h-3.5 w-3.5" /> วนท่อน
              </span>
              <Button variant={loopA != null ? "secondary" : "outline"} size="sm" onClick={setA}>
                A{loopA != null ? ` · ${mmss(loopA)}` : ""}
              </Button>
              <Button variant={loopB != null ? "secondary" : "outline"} size="sm" onClick={setB}>
                B{loopB != null ? ` · ${mmss(loopB)}` : ""}
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
                {canManage && curMarkers.length > 0 && (
                  <button
                    onClick={() => setEditMarkers((v) => !v)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" /> {editMarkers ? "เสร็จ" : "แก้ไข"}
                  </button>
                )}
              </div>

              {curMarkers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {canManage ? "ยังไม่มีท่อน — เพิ่มจากปุ่มด้านล่าง" : "ยังไม่มีท่อน"}
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
                      {editMarkers && canManage && (
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

              {canManage && (
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
              )}
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่ได้เลือกเพลง — แตะเพลงด้านล่างเพื่อเริ่มซ้อม
          </p>
        )}
      </div>

      {/* Library picker */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลงในคลัง..."
            className="pl-8"
          />
        </div>

        {playable.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีเพลงที่มีไฟล์เสียงในคลังของวงนี้
            <br />
            อัปโหลดเพลงในคลังเพลงก่อน แล้วกลับมาซ้อมได้เลย
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {filtered.map((s) => {
              const active = s.id === currentId;
              const loading = s.id === loadingId;
              const mCount = (markers[s.id] ?? []).length;
              return (
                <button
                  key={s.id}
                  onClick={() => selectSong(s)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                    active ? "bg-primary/10" : "hover:bg-muted/50"
                  )}
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
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {s.duration_seconds > 0 && <span>{mmss(s.duration_seconds)}</span>}
                      {mCount > 0 && (
                        <span className="flex items-center gap-0.5">
                          <MapPin className="h-3 w-3" /> {mCount}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                ไม่พบเพลงที่ค้นหา
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
