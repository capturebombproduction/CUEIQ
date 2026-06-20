"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  Loader2,
  Music2,
  Gauge,
  Volume2,
  SkipBack,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { downloadEventAudio } from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Song } from "@/lib/types";

// Speed presets — slowing down for practice. Pitch is preserved (see preservesPitch
// below) so 0.5x stays in the same key, just slower.
const SPEEDS = [1, 0.75, 0.5] as const;

function mmss(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Practice Mode — Slice 1 (player). Pick any library song that has audio and play
 * it with a slow-down (1.0 / 0.75 / 0.5, pitch preserved) + scrubber. Markers /
 * A-B loop / break timer / practice journal land in later slices. Single device,
 * online: audio streams from R2 on demand (no cross-device sync like Live Mode).
 */
export function PracticeMode({
  roomName,
  songs,
}: {
  roomName: string;
  songs: Song[];
}) {
  // Only songs with an actual audio file are playable here.
  const playable = useMemo(
    () => songs.filter((s) => !!s.audio_path),
    [songs]
  );
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return playable;
    return playable.filter((s) => s.title.toLowerCase().includes(q));
  }, [playable, query]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null); // active object URL, revoked on swap/unmount
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [vol, setVol] = useState(100);

  const current = playable.find((s) => s.id === currentId) ?? null;

  // one audio element for the whole session
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    audioRef.current = a;
    const onTime = () => setCur(a.currentTime);
    const onMeta = () => setDur(a.duration);
    const onEnd = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
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
  }, []);

  // keep playbackRate + pitch-preservation in sync with the chosen speed
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = speed;
    // standard + vendor-prefixed flags so the key doesn't drop when slowed
    a.preservesPitch = true;
    // @ts-expect-error vendor-prefixed fallback (older WebKit/Firefox)
    a.webkitPreservesPitch = true;
    // @ts-expect-error vendor-prefixed fallback (older Firefox)
    a.mozPreservesPitch = true;
  }, [speed, currentId]);

  // volume
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = Math.min(1, Math.max(0, vol / 100));
  }, [vol]);

  // Wake Lock — keep the screen on while a track plays (long practice loops)
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
      // same track — toggle play/pause
      if (a.paused) a.play().catch(() => {});
      else a.pause();
      return;
    }
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
      a.playbackRate = speed; // re-apply (src change can reset it on some browsers)
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

  function restart() {
    seek(0);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Music2 className="h-5 w-5" /> {roomName}
        </h1>
        <p className="text-xs text-muted-foreground">โหมดซ้อม — เลือกเพลงจากคลังเพื่อเริ่มซ้อม</p>
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

            {/* scrubber */}
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

            {/* transport */}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={restart} title="กลับไปต้นเพลง">
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button size="icon" className="h-11 w-11" onClick={togglePlay}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </Button>

              {/* speed */}
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

              {/* volume */}
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
                    {s.duration_seconds > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {mmss(s.duration_seconds)}
                      </span>
                    )}
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
