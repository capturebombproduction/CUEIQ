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

function clampBpm(n: number) {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));
}

/**
 * Practice metronome (Slice 4 + count mode) — Web Audio scheduled clicks (accented
 * downbeat) OR a spoken count ("one, two, three… eight" via SpeechSynthesis), with
 * its OWN volume (separate from the song), tap-tempo, beats-per-bar, and a per-song
 * saved BPM (Ar). Self-contained; nothing plays until ▶ (which also unlocks audio
 * on iOS).
 */
export function Metronome({
  song,
  canManage,
  onBpmSaved,
}: {
  song: Song | null;
  canManage: boolean;
  onBpmSaved?: (songId: string, bpm: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [bpm, setBpm] = useState<number>(song?.bpm ?? 100);
  const [beats, setBeats] = useState<number>(8);
  const [mode, setMode] = useState<SoundMode>("click");
  const [vol, setVol] = useState(80); // metronome volume (0–100), independent of the song
  const [running, setRunning] = useState(false);
  const [beatLabel, setBeatLabel] = useState(0); // current beat shown in the dial

  // live refs for the running scheduler
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const volRef = useRef(vol);
  volRef.current = vol;

  const ctxRef = useRef<AudioContext | null>(null);
  const nextNoteRef = useRef(0);
  const beatNumRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tapsRef = useRef<number[]>([]);

  useEffect(() => {
    if (song?.bpm) setBpm(clampBpm(song.bpm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);

  function speak(n: number) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel(); // drop any backlog so counts stay in time
      const u = new SpeechSynthesisUtterance(String(n));
      u.lang = "en-US";
      u.rate = 1.5;
      u.volume = Math.min(1, Math.max(0, volRef.current / 100));
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  function clickAt(time: number, accent: boolean) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = accent ? 1600 : 1000;
    const peak = (accent ? 0.6 : 0.4) * (volRef.current / 100);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  function scheduleBeat(time: number, beatIndex: number) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const accent = beatIndex === 0;
    if (modeRef.current === "click") {
      clickAt(time, accent);
    }
    // visual + (voice) fire at the actual beat moment
    const delay = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      setBeatLabel(beatIndex + 1);
      if (modeRef.current === "voice") speak(beatIndex + 1);
    }, delay);
  }

  function schedule() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const spb = 60 / bpmRef.current;
    while (nextNoteRef.current < ctx.currentTime + 0.12) {
      scheduleBeat(nextNoteRef.current, beatNumRef.current % beatsRef.current);
      nextNoteRef.current += spb;
      beatNumRef.current = (beatNumRef.current + 1) % beatsRef.current;
    }
  }

  function start() {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    ctxRef.current = ctx;
    beatNumRef.current = 0;
    nextNoteRef.current = ctx.currentTime + 0.12;
    timerRef.current = setInterval(schedule, 25);
    setRunning(true);
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    setRunning(false);
    setBeatLabel(0);
  }

  function toggle() {
    if (running) stop();
    else start();
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      ctxRef.current?.close().catch(() => {});
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, []);

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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <AudioWaveform className="h-4 w-4" /> เมโทรนอม
      </Button>
    );
  }

  return (
    <div className="w-full rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <AudioWaveform className="h-4 w-4" /> เมโทรนอม
        </span>
        <button
          onClick={() => {
            stop();
            setOpen(false);
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ปิด
        </button>
      </div>

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

        <Button size="icon" className="h-11 w-11" onClick={toggle}>
          {running ? <Square className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>

        <Button variant="outline" size="sm" onClick={tap}>
          <Hand className="h-4 w-4" /> เคาะจังหวะ
        </Button>

        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{bpm} BPM</span>
      </div>

      <input
        type="range"
        min={MIN_BPM}
        max={MAX_BPM}
        value={bpm}
        onChange={(e) => setBpm(clampBpm(Number(e.target.value)))}
        className="mt-3 w-full accent-[var(--primary)]"
      />

      {/* mode: click vs spoken count */}
      <div className="mt-2 flex items-center gap-2">
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
            นับเลข (1–{beats})
          </button>
        </div>
      </div>

      {/* metronome volume — independent of the song's volume */}
      <div className="mt-2 flex items-center gap-2">
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

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
