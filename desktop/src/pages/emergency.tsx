// โหมดฉุกเฉิน — the last-resort show player. Zero login, zero network, zero
// account: pick audio files straight off this machine and run them in order.
// Exists so a BRAND-NEW machine (never signed in — the one case the offline
// show pass can't cover, since first login needs the network) can still open
// the program and play the set. Files never leave the machine: they play from
// object URLs and are forgotten when the page closes.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  FolderOpen,
  Music2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Track {
  id: string;
  name: string;
  url: string;
}

function mmss(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function EmergencyPlayer() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(100);
  // เปิดต่อเนื่อง: when a song ends, start the next one — the "เปิดสวน" default.
  const [autoNext, setAutoNext] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // refs so the one-time "ended" listener always sees current values
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const autoNextRef = useRef(autoNext);
  autoNextRef.current = autoNext;
  const playNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    const a = new Audio();
    a.addEventListener("timeupdate", () => setCur(a.currentTime));
    a.addEventListener("loadedmetadata", () => setDur(isFinite(a.duration) ? a.duration : 0));
    a.addEventListener("play", () => setPlaying(true));
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("ended", () => {
      if (autoNextRef.current) playNextRef.current();
    });
    audioRef.current = a;
    const urls = tracksRef.current;
    return () => {
      a.pause();
      a.src = "";
      audioRef.current = null;
      urls.forEach((t) => URL.revokeObjectURL(t.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.min(1, Math.max(0, vol / 100));
  }, [vol]);

  // keep the screen awake while sound is playing (same as Live Mode)
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

  function playTrack(t: Track) {
    const a = audioRef.current;
    if (!a) return;
    if (t.id === currentId) {
      if (a.paused) a.play().catch(() => {});
      else a.pause();
      return;
    }
    a.src = t.url;
    a.currentTime = 0;
    setCurrentId(t.id);
    setCur(0);
    a.play().catch(() => {});
  }

  function step(dir: -1 | 1) {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const i = list.findIndex((t) => t.id === currentIdRef.current);
    const j = i < 0 ? 0 : i + dir;
    if (j < 0 || j >= list.length) return;
    playTrack(list[j]);
  }
  playNextRef.current = () => step(1);

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const added: Track[] = Array.from(files).map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      url: URL.createObjectURL(f),
    }));
    setTracks((prev) => [...prev, ...added]);
  }

  function removeTrack(id: string) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    if (id === currentId) {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.src = "";
      setCurrentId(null);
      setCur(0);
      setDur(0);
    }
    URL.revokeObjectURL(t.url);
    setTracks((prev) => prev.filter((x) => x.id !== id));
  }

  const current = tracks.find((t) => t.id === currentId) ?? null;
  const curIndex = current ? tracks.findIndex((t) => t.id === current.id) : -1;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/login">
              <ArrowLeft className="h-4 w-4" /> กลับหน้าเข้าสู่ระบบ
            </Link>
          </Button>
        </div>

        <div className="rounded-xl border bg-card p-4 text-center">
          <h1 className="text-xl font-bold">โหมดฉุกเฉิน · เปิดเพลงจากเครื่อง</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            ไม่ต้องเข้าสู่ระบบ ไม่ใช้เน็ต — ไฟล์เล่นจากเครื่องนี้เท่านั้น ไม่ถูกอัปโหลดไปไหน
          </p>
        </div>

        {/* now playing + transport */}
        <div className="rounded-xl border bg-card p-4">
          <input
            ref={inputRef}
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {current ? (
            <>
              <div className="mb-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Music2 className="h-3.5 w-3.5" />
                {curIndex + 1} / {tracks.length}
              </div>
              <p className="mb-3 break-words text-center text-lg font-semibold leading-tight">
                {current.name}
              </p>
              <input
                type="range"
                min={0}
                max={dur || 1}
                step={0.1}
                value={cur}
                onChange={(e) => {
                  if (audioRef.current) audioRef.current.currentTime = Number(e.target.value);
                }}
                className="w-full accent-[var(--primary)]"
              />
              <div className="mb-3 flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{mmss(cur)}</span>
                <span>{mmss(dur)}</span>
              </div>
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-11 w-11"
                  onClick={() => step(-1)}
                  disabled={curIndex <= 0}
                  title="เพลงก่อนหน้า"
                >
                  <SkipBack className="h-5 w-5" />
                </Button>
                <Button
                  size="icon"
                  className="h-14 w-14"
                  onClick={() => playTrack(current)}
                  title={playing ? "หยุดชั่วคราว" : "เล่น"}
                >
                  {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-11 w-11"
                  onClick={() => step(1)}
                  disabled={curIndex < 0 || curIndex >= tracks.length - 1}
                  title="เพลงถัดไป"
                >
                  <SkipForward className="h-5 w-5" />
                </Button>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={vol}
                  onChange={(e) => setVol(Number(e.target.value))}
                  className="w-full accent-[var(--primary)]"
                />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {vol}%
                </span>
              </div>
            </>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              ยังไม่ได้เลือกเพลง — เพิ่มไฟล์แล้วแตะเพลงเพื่อเริ่มเล่น
            </p>
          )}
        </div>

        {/* playlist */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              รายการเพลง{tracks.length > 0 ? ` · ${tracks.length} เพลง` : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAutoNext((v) => !v)}
                title={
                  autoNext
                    ? "เล่นต่อเนื่องเปิดอยู่ — จบเพลงแล้วขึ้นเพลงถัดไปเอง"
                    : "เล่นต่อเนื่องปิดอยู่ — จบเพลงแล้วหยุด"
                }
                className={cn(
                  "flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                  autoNext
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <Repeat className="h-3.5 w-3.5" /> เล่นต่อเนื่อง {autoNext ? "เปิด" : "ปิด"}
              </button>
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
                <FolderOpen className="h-4 w-4" /> เพิ่มเพลง
              </Button>
            </div>
          </div>

          {tracks.length === 0 ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground hover:bg-muted/40"
            >
              <FolderOpen className="mx-auto mb-2 h-6 w-6" />
              แตะเพื่อเลือกไฟล์เพลงจากเครื่องนี้ (เลือกได้หลายไฟล์)
            </button>
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {tracks.map((t, i) => {
                const active = t.id === currentId;
                return (
                  <div
                    key={t.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2.5",
                      active ? "bg-primary/10" : "hover:bg-muted/50"
                    )}
                  >
                    <button
                      onClick={() => playTrack(t)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        {active && playing ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </span>
                      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm",
                          active && "font-medium"
                        )}
                      >
                        {t.name}
                      </span>
                    </button>
                    <button
                      onClick={() => removeTrack(t.id)}
                      title="เอาออกจากรายการ"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="px-1 text-center text-[11px] text-muted-foreground">
          โหมดนี้คือแผนสำรองสุดท้าย — เครื่องที่ล็อกอินแล้วใช้ Live Mode จะได้ตัวจับเวลา ซิงค์ และคิวเต็มรูปแบบ
        </p>
      </div>
    </div>
  );
}
