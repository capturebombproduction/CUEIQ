"use client";

import { useEffect, useRef, useState } from "react";
import {
  Minus,
  Plus,
  Play,
  Square,
  Hand,
  Save,
  AudioWaveform,
  Volume2,
  Link2,
  Crosshair,
  Wand2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Song } from "@/lib/types";

const MIN_BPM = 30;
const MAX_BPM = 280;
const BEATS_OPTIONS = [2, 3, 4, 6, 8] as const;
type SoundMode = "click" | "voice";

// Voices that sound female across the common platforms (iOS Safari, macOS,
// Windows/Edge, Android Chrome). We match by name and fall back gracefully.
const FEMALE_VOICE = /(samantha|zira|aria|jenny|female|karen|moira|tessa|fiona|victoria|susan|catherine|serena|allison|ava|nicky|google us english|google uk english female)/i;

function clampBpm(n: number) {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));
}

/**
 * Practice metronome — syncs to the song.
 *
 * In SYNC mode (default when a song with audio is loaded) it follows the player's
 * transport: it starts/stops with playback, runs at the song's saved BPM, stays
 * in phase with the playback position (so it survives seeking + A-B loops), and
 * scales with the slow-down speed (at 0.5× the beats are spaced twice as wide in
 * real time, so they still land on the music). No manual start needed — that's the
 * "hard to use" problem solved. A "ตั้งบีตแรก" tap re-phases beat 1 to the moment.
 *
 * Without a song (or with sync off) it falls back to a free-running manual
 * metronome with tap-tempo.
 *
 * Sound is either a Web Audio click (accented downbeat, mid-accent on 5 of an
 * 8-count) or a spoken FEMALE count — "one, two … eight", dance-studio style.
 * Metronome volume is independent of the song. Ar can save the BPM to the song.
 */
export function Metronome({
  song,
  canManage,
  playing = false,
  position = 0,
  speed = 1,
  onBpmSaved,
  onDetectBpm,
}: {
  song: Song | null;
  canManage: boolean;
  playing?: boolean;
  position?: number;
  speed?: number;
  onBpmSaved?: (songId: string, bpm: number) => void;
  onDetectBpm?: () => Promise<number | null>;
}) {
  const canSync = !!song?.audio_path;

  const [open, setOpen] = useState(false);
  const [bpm, setBpm] = useState<number>(song?.bpm ?? 100);
  const [beats, setBeats] = useState<number>(8); // dance 8-count by default
  const [mode, setMode] = useState<SoundMode>("voice"); // spoken count by default
  const [sync, setSync] = useState(true); // follow the song
  const [vol, setVol] = useState(80); // metronome volume (0–100), independent of the song
  const [running, setRunning] = useState(false);
  const [beatLabel, setBeatLabel] = useState(0); // current beat shown in the dial
  const [detecting, setDetecting] = useState(false); // analysing audio for its BPM

  // live refs for the running scheduler (so it reads the latest values)
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const volRef = useRef(vol);
  volRef.current = vol;
  const syncedRef = useRef(sync && canSync);
  syncedRef.current = sync && canSync;
  const runningRef = useRef(false);
  const transportRef = useRef({ playing, position, speed });
  transportRef.current = { playing, position, speed };

  const ctxRef = useRef<AudioContext | null>(null);
  const nextNoteRef = useRef(0); // ctx time of the next beat to schedule
  const beatAbsRef = useRef(0); // absolute beat index from the grid origin
  const gridBaseRef = useRef(0); // song-time of beat "1" (origin of the beat grid)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tapsRef = useRef<number[]>([]);
  const lastPosRef = useRef(position);

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const canSpeakRef = useRef(false);

  useEffect(() => {
    if (song?.bpm) setBpm(clampBpm(song.bpm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);

  // Pick a female voice once the platform's voice list is available.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const load = () => {
      const voices = synth.getVoices();
      if (!voices.length) return;
      const en = voices.filter((v) => /en/i.test(v.lang));
      const pool = en.length ? en : voices;
      voiceRef.current = pool.find((v) => FEMALE_VOICE.test(v.name)) || pool[0] || null;
      canSpeakRef.current = true;
    };
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, []);

  // --- audio context (kept open while the panel is open; unlocked on a gesture) ---
  function ensureCtxUnlocked() {
    if (!ctxRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  }
  function closeCtx() {
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }

  function speak(n: number) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel(); // drop any backlog so counts stay in time
      const u = new SpeechSynthesisUtterance(String(n));
      const v = voiceRef.current;
      if (v) u.voice = v;
      u.lang = v?.lang || "en-US";
      u.rate = 1.35;
      u.pitch = 1.1; // a touch brighter
      u.volume = Math.min(1, Math.max(0, volRef.current / 100));
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  function clickAt(time: number, level: "strong" | "mid" | "normal") {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = level === "strong" ? 1600 : level === "mid" ? 1300 : 1000;
    const base = level === "strong" ? 0.6 : level === "mid" ? 0.5 : 0.4;
    const peak = base * (volRef.current / 100);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  function scheduleBeat(time: number, abs: number) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const nBeats = beatsRef.current;
    const idx = ((abs % nBeats) + nBeats) % nBeats;
    const voiceOn = modeRef.current === "voice" && canSpeakRef.current;
    if (!voiceOn) {
      const level = idx === 0 ? "strong" : nBeats === 8 && idx === 4 ? "mid" : "normal";
      clickAt(time, level);
    }
    // visual + (voice) fire at the actual beat moment
    const delay = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      setBeatLabel(idx + 1);
      if (voiceOn) speak(idx + 1);
    }, delay);
  }

  // beat spacing in REAL (ctx) seconds — scaled by the slow-down speed in sync mode
  function realSpb() {
    const songSpb = 60 / bpmRef.current;
    if (syncedRef.current) return songSpb / Math.max(0.01, transportRef.current.speed || 1);
    return songSpb;
  }

  function schedule() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    while (nextNoteRef.current < ctx.currentTime + 0.12) {
      scheduleBeat(nextNoteRef.current, beatAbsRef.current);
      nextNoteRef.current += realSpb();
      beatAbsRef.current += 1;
    }
  }

  // Phase-lock the beat grid to the song's current position (sync mode).
  function anchorSync() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { position: pos, speed: spd } = transportRef.current;
    const songSpb = 60 / bpmRef.current;
    const grid = gridBaseRef.current;
    const phase = (((pos - grid) % songSpb) + songSpb) % songSpb;
    const toNext = phase < 1e-4 ? 0 : songSpb - phase;
    beatAbsRef.current = Math.round((pos - grid + toNext) / songSpb);
    nextNoteRef.current = ctx.currentTime + toNext / Math.max(0.01, spd || 1);
  }

  function startScheduler(anchored: boolean) {
    const ctx = ensureCtxUnlocked();
    if (timerRef.current) clearInterval(timerRef.current);
    if (anchored) {
      anchorSync();
    } else {
      beatAbsRef.current = 0;
      nextNoteRef.current = ctx.currentTime + 0.1;
    }
    timerRef.current = setInterval(schedule, 25);
    runningRef.current = true;
    setRunning(true);
  }

  function stopScheduler() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    runningRef.current = false;
    setRunning(false);
    setBeatLabel(0);
  }

  // --- sync mode: follow the song's transport -------------------------------
  // Leaving sync stops any sync-driven run (manual restart is via the ▶ button).
  useEffect(() => {
    if (!(sync && canSync)) stopScheduler();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, canSync]);

  // Start/stop with playback while synced (only when the panel is open).
  useEffect(() => {
    if (!open || !(sync && canSync)) return;
    if (playing) startScheduler(true);
    else stopScheduler();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sync, canSync, playing, song?.id]);

  // Re-phase on tempo / speed change while running.
  useEffect(() => {
    if (sync && canSync && playing && runningRef.current) anchorSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm, speed]);

  // Re-phase on a position discontinuity (A-B loop, scrub, marker jump).
  useEffect(() => {
    if (!(sync && canSync) || !playing) {
      lastPosRef.current = position;
      return;
    }
    const prev = lastPosRef.current;
    lastPosRef.current = position;
    if (runningRef.current && (position < prev - 0.08 || position > prev + 0.8)) anchorSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      closeCtx();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // --- manual mode ----------------------------------------------------------
  function manualToggle() {
    if (running) stopScheduler();
    else startScheduler(false);
  }

  function tap() {
    const now = performance.now();
    const taps = tapsRef.current;
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avg > 0) setBpm(clampBpm(60000 / avg));
    }
  }

  // Re-phase beat 1 to "now" (tap this on the song's downbeat to line it up).
  function setBeatOne() {
    gridBaseRef.current = transportRef.current.position;
    if (runningRef.current) anchorSync();
  }

  async function detect() {
    if (!onDetectBpm || detecting) return;
    setDetecting(true);
    try {
      const guess = await onDetectBpm();
      if (guess && guess > 0) {
        setBpm(clampBpm(guess)); // the [bpm] effect re-phases the running metronome
        toast.success(`ตรวจจับได้ ~${clampBpm(guess)} BPM`, {
          description: "ถ้ารู้สึกเร็ว/ช้าไปเท่าตัว กด ÷2 หรือ ×2",
        });
      } else {
        toast.error("ตรวจจับจังหวะไม่ได้", { description: "ลองเคาะจังหวะเองหรือปรับเลข BPM" });
      }
    } catch (e) {
      toast.error("ตรวจจับจังหวะไม่ได้", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDetecting(false);
    }
  }

  async function saveBpm() {
    if (!song || !canManage) return;
    const supabase = createClient();
    const { error } = await supabase.from("songs").update({ bpm }).eq("id", song.id);
    if (error) {
      toast.error("บันทึก BPM ไม่สำเร็จ", { description: error.message });
      return;
    }
    onBpmSaved?.(song.id, bpm);
    toast.success(`บันทึก ${bpm} BPM ลง “${song.title}”`);
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          ensureCtxUnlocked(); // unlock within this tap so iOS lets auto-start make sound
          setOpen(true);
        }}
      >
        <AudioWaveform className="h-4 w-4" /> เมโทรนอม
      </Button>
    );
  }

  const isSync = sync && canSync;

  return (
    <div className="w-full space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <AudioWaveform className="h-4 w-4" /> เมโทรนอม
        </span>
        <button
          onClick={() => {
            stopScheduler();
            closeCtx();
            setOpen(false);
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ปิด
        </button>
      </div>

      {/* sync with song */}
      {canSync && (
        <button
          onClick={() => {
            ensureCtxUnlocked();
            setSync((s) => !s);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
            isSync ? "border-primary bg-primary/10" : "hover:bg-muted/50"
          )}
        >
          <Link2 className={cn("h-4 w-4 shrink-0", isSync ? "text-primary" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">ซิงก์กับเพลง</span>
            <span className="block text-xs text-muted-foreground">
              {isSync ? "เริ่ม/หยุด + จังหวะตามเพลงอัตโนมัติ" : "แตะเพื่อให้ตามเพลงเอง"}
            </span>
          </span>
          <span
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full transition-colors",
              isSync ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                isSync ? "left-[18px]" : "left-0.5"
              )}
            />
          </span>
        </button>
      )}

      {/* dial + transport */}
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 tabular-nums transition-colors",
            running && beatLabel === 1 ? "border-primary bg-primary/20" : "border-muted"
          )}
        >
          <span className="text-lg font-bold">{running ? beatLabel || "·" : bpm}</span>
        </span>

        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => setBpm((b) => clampBpm(b - 1))}>
            <Minus className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => setBpm((b) => clampBpm(b + 1))}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {isSync ? (
          <Button
            variant="outline"
            size="sm"
            onClick={setBeatOne}
            disabled={!running}
            title="แตะตอนเสียงตกจังหวะแรก เพื่อจัด 1 ให้ตรง"
          >
            <Crosshair className="h-4 w-4" /> ตั้งบีตแรก
          </Button>
        ) : (
          <>
            <Button size="icon" className="h-11 w-11" onClick={manualToggle}>
              {running ? <Square className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </Button>
            <Button variant="outline" size="sm" onClick={tap}>
              <Hand className="h-4 w-4" /> เคาะจังหวะ
            </Button>
          </>
        )}

        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{bpm} BPM</span>
      </div>

      <input
        type="range"
        min={MIN_BPM}
        max={MAX_BPM}
        value={bpm}
        onChange={(e) => setBpm(clampBpm(Number(e.target.value)))}
        className="w-full accent-[var(--primary)]"
      />

      {/* auto BPM detection from the song's audio (+ octave fixups) */}
      {canSync && onDetectBpm && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={detect} disabled={detecting}>
            {detecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            {detecting ? "กำลังตรวจจับ…" : "ตรวจจับจังหวะจากเพลง"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBpm((b) => clampBpm(b / 2))}
            title="ช้าลงครึ่งหนึ่ง"
          >
            ÷2
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBpm((b) => clampBpm(b * 2))}
            title="เร็วขึ้นเท่าตัว"
          >
            ×2
          </Button>
        </div>
      )}

      {isSync && !playing && (
        <p className="text-xs text-muted-foreground">▶ เล่นเพลงแล้วเมโทรนอมจะเริ่มเองตามจังหวะ</p>
      )}

      {/* mode: click vs spoken count */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">เสียง</span>
        <div className="flex overflow-hidden rounded-md border text-xs">
          <button
            onClick={() => setMode("click")}
            className={cn(
              "px-2.5 py-1.5 transition-colors",
              mode === "click"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            คลิก
          </button>
          <button
            onClick={() => setMode("voice")}
            className={cn(
              "px-2.5 py-1.5 transition-colors",
              mode === "voice"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            นับ 1–{beats} (ผู้หญิง)
          </button>
        </div>
        {mode === "voice" && !canSpeakRef.current && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            เครื่องนี้ไม่มีเสียงพูด — จะใช้คลิกแทน
          </span>
        )}
      </div>

      {/* metronome volume — independent of the song's volume */}
      <div className="flex items-center gap-2">
        <Volume2 className="h-4 w-4 text-muted-foreground" />
        <span className="w-20 shrink-0 text-xs text-muted-foreground">ดังเมโทรนอม</span>
        <input
          type="range"
          min={0}
          max={100}
          value={vol}
          onChange={(e) => setVol(Number(e.target.value))}
          className="w-full accent-[var(--primary)]"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">บีตต่อห้อง</span>
        {BEATS_OPTIONS.map((b) => (
          <button
            key={b}
            onClick={() => setBeats(b)}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              beats === b
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            )}
          >
            {b}
          </button>
        ))}

        {canManage && song && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={saveBpm}>
            <Save className="h-4 w-4" /> บันทึกลงเพลง
          </Button>
        )}
      </div>
    </div>
  );
}
