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

// Re-derive a working beat grid from the detected beats for an octave factor:
// >1 subdivides each gap (×2 → twice as many beats), <1 keeps every Nth beat
// (÷2 → half as many). Used by the ÷2/×2 buttons to fix octave-off detections
// while staying beat-LOCKED (not just changing a free-run BPM number).
function octaveBeats(base: number[], octave: number): number[] {
  if (octave === 1 || base.length < 2) return base.slice();
  if (octave > 1) {
    const sub = Math.round(octave);
    const out: number[] = [];
    for (let i = 0; i < base.length - 1; i++) {
      const a = base[i];
      const b = base[i + 1];
      for (let k = 0; k < sub; k++) out.push(a + ((b - a) * k) / sub);
    }
    out.push(base[base.length - 1]);
    return out;
  }
  const step = Math.max(1, Math.round(1 / octave));
  return base.filter((_, i) => i % step === 0);
}

/**
 * Practice metronome — syncs to the song.
 *
 * In SYNC mode (default when a song with audio is loaded) it follows the player's
 * transport: it starts/stops with playback and stays locked to the music.
 *
 * Two sync strategies:
 *   • BEAT-LOCKED (best) — after "ตรวจจับจังหวะจากเพลง" runs the audio beat tracker
 *     we have the ACTUAL beat times. The scheduler clicks exactly on those times
 *     (mapped from song position to the audio clock via a play anchor + speed), so
 *     it never drifts and auto-phases — no free-running clock to slide off a real
 *     recording. ÷2/×2 thin/subdivide the beats; "ตั้งบีตแรก" picks which beat is "1".
 *   • FREE-RUN (fallback) — no detected beats yet: run a steady clock at the saved
 *     BPM, phase-locked to the playback position. Survives seeks/A-B loops and
 *     scales with the slow-down speed, but can drift on a non-quantised recording.
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
  onDetectBeats,
}: {
  song: Song | null;
  canManage: boolean;
  playing?: boolean;
  position?: number;
  speed?: number;
  onBpmSaved?: (songId: string, bpm: number) => void;
  onDetectBeats?: () => Promise<{ bpm: number; beats: number[] } | null>;
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
  const [hasBeats, setHasBeats] = useState(false); // beat-locked (vs free-run) sync

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
  const nextNoteRef = useRef(0); // ctx time of the next beat to schedule (free-run)
  const beatAbsRef = useRef(0); // absolute beat index from the grid origin (free-run)
  const gridBaseRef = useRef(0); // song-time of beat "1" (origin of the beat grid, free-run)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genRef = useRef(0); // bumped on stop so queued beat callbacks don't leak
  // Scheduled audio nodes (count samples + clicks) committed to the audio clock up
  // to the lookahead ahead of "now". Tracked so a stop/pause can cancel the ones
  // that haven't sounded yet — otherwise a trailing beat leaks ~120ms after stop.
  const liveNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const tapsRef = useRef<number[]>([]);
  const lastPosRef = useRef(position);
  const songIdRef = useRef(song?.id); // for detect() to spot a song switch mid-analysis
  songIdRef.current = song?.id;

  // --- beat-locked scheduling (from the audio beat tracker) -----------------
  const detectedBeatsRef = useRef<number[] | null>(null); // raw detected beat times (s)
  const detectedBpmRef = useRef(0); // raw detected BPM (before octave fixups)
  const octaveRef = useRef(1); // ÷2/×2 factor applied to the detected beats
  const beatTimesRef = useRef<number[] | null>(null); // working beat times (octave-adjusted)
  const beatPtrRef = useRef(0); // index of the next beat to schedule
  const beatOriginRef = useRef(0); // which working-beat index counts as "1"
  const anchorCtxRef = useRef(0); // ctx time at the anchor
  const anchorPosRef = useRef(0); // song position (s) at the anchor

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const canSpeakRef = useRef(false);

  // Pre-recorded count samples ("one".."eight", cute JP-accented female voice):
  // scheduled sample-accurately via Web Audio so the count lands ON the beat,
  // unlike live SpeechSynthesis (which lags). rawCountRef = fetched mp3 bytes;
  // countBuffersRef = decoded per audio context. See public/sounds/count/.
  const rawCountRef = useRef<ArrayBuffer[]>([]);
  const countBuffersRef = useRef<(AudioBuffer | null)[]>([]);

  useEffect(() => {
    if (song?.bpm) setBpm(clampBpm(song.bpm));
    // detected beats belong to the previous song — drop them (fall back to free-run)
    detectedBeatsRef.current = null;
    detectedBpmRef.current = 0;
    beatTimesRef.current = null;
    octaveRef.current = 1;
    beatOriginRef.current = 0;
    setHasBeats(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);

  // Fetch the count samples once (tiny; the service worker caches them so they're
  // on-device for stability, like Live Mode's prefetch).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bytes = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            fetch(`/sounds/count/${i + 1}.mp3`).then((r) =>
              r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))
            )
          )
        );
        if (!alive) return;
        rawCountRef.current = bytes;
        if (ctxRef.current) void decodeCount(ctxRef.current);
      } catch {
        /* fall back to TTS / click */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    void decodeCount(ctx); // make sure the count samples are ready for this ctx
    return ctx;
  }
  function closeCtx() {
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    countBuffersRef.current = []; // decoded against the old ctx — re-decode on reopen
  }

  // Decode the fetched count mp3s for this context (once). slice(0) clones so the
  // raw bytes survive decodeAudioData detaching them (lets us re-decode later).
  async function decodeCount(ctx: AudioContext) {
    const raw = rawCountRef.current;
    if (raw.length < 8) return;
    if (countBuffersRef.current.length === 8 && countBuffersRef.current.every(Boolean)) return;
    const out: (AudioBuffer | null)[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        out[i] = await ctx.decodeAudioData(raw[i].slice(0));
      } catch {
        out[i] = null;
      }
    }
    countBuffersRef.current = out;
  }

  // Track a scheduled node so stopScheduler can cancel it if it hasn't fired yet
  // (drops itself from the set once it ends, so the set only holds pending/sounding).
  function track(node: AudioScheduledSourceNode) {
    liveNodesRef.current.add(node);
    node.addEventListener("ended", () => liveNodesRef.current.delete(node));
  }

  // Schedule a decoded count sample exactly at `time` (on the audio clock).
  function playSample(buf: AudioBuffer, time: number) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, Math.max(0, volRef.current / 100));
    src.connect(g);
    g.connect(ctx.destination);
    src.start(time);
    track(src);
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
    track(osc);
  }

  function scheduleBeat(time: number, abs: number) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const nBeats = beatsRef.current;
    const idx = ((abs % nBeats) + nBeats) % nBeats;
    const wantVoice = modeRef.current === "voice";
    const sample = wantVoice ? countBuffersRef.current[idx] : null;
    // Preloaded sample → schedule it on the audio clock (tight). No sample but a
    // platform voice → fall back to live TTS (laggy). Otherwise click.
    const ttsFallback = wantVoice && !sample && canSpeakRef.current;
    if (sample) {
      playSample(sample, time);
    } else if (!ttsFallback) {
      const level = idx === 0 ? "strong" : nBeats === 8 && idx === 4 ? "mid" : "normal";
      clickAt(time, level);
    }
    // visual (+ TTS fallback) fire at the actual beat moment
    const delay = Math.max(0, (time - ctx.currentTime) * 1000);
    const gen = genRef.current;
    setTimeout(() => {
      if (gen !== genRef.current) return; // stopped/restarted since — don't leak
      setBeatLabel(idx + 1);
      if (ttsFallback) speak(idx + 1);
    }, delay);
  }

  // beat spacing in REAL (ctx) seconds — scaled by the slow-down speed in sync mode
  function realSpb() {
    const songSpb = 60 / bpmRef.current;
    if (syncedRef.current) return songSpb / Math.max(0.01, transportRef.current.speed || 1);
    return songSpb;
  }

  // beat-locked when synced AND the tracker gave us real beat times
  function beatLockActive() {
    const beats = beatTimesRef.current;
    return syncedRef.current && !!beats && beats.length > 0;
  }

  function schedule() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const beats = beatTimesRef.current;
    if (beatLockActive() && beats) {
      // Map each beat's song-time to ctx time via the anchor + speed and schedule
      // the ones falling in the lookahead window. Drift-free: every click is a real
      // beat position, not a free-running clock.
      const spd = Math.max(0.01, transportRef.current.speed || 1);
      const horizon = ctx.currentTime + 0.12;
      let ptr = beatPtrRef.current;
      while (ptr < beats.length) {
        const ctxT = anchorCtxRef.current + (beats[ptr] - anchorPosRef.current) / spd;
        if (ctxT < ctx.currentTime - 0.05) {
          ptr++; // already past (after a jump / fell behind) — skip silently
          continue;
        }
        if (ctxT >= horizon) break;
        scheduleBeat(ctxT, ptr - beatOriginRef.current);
        ptr++;
      }
      beatPtrRef.current = ptr;
      return;
    }
    // free-run fallback
    while (nextNoteRef.current < ctx.currentTime + 0.12) {
      scheduleBeat(nextNoteRef.current, beatAbsRef.current);
      nextNoteRef.current += realSpb();
      beatAbsRef.current += 1;
    }
  }

  // Phase-lock the metronome to the song's current position (sync mode).
  function anchorSync() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { position: pos, speed: spd } = transportRef.current;
    const beats = beatTimesRef.current;
    if (beatLockActive() && beats) {
      // anchor the song↔ctx clock mapping at "now", point at the first beat ≥ pos
      anchorCtxRef.current = ctx.currentTime;
      anchorPosRef.current = pos;
      let lo = 0;
      let hi = beats.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] < pos) lo = mid + 1;
        else hi = mid;
      }
      beatPtrRef.current = lo;
      return;
    }
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
    genRef.current++; // invalidate any beat callbacks already queued ahead
    // cancel any click/count already scheduled on the audio clock but not yet
    // sounded (or still sounding) so no stray beat leaks out after stop/pause
    liveNodesRef.current.forEach((n) => {
      try {
        n.stop();
      } catch {
        /* already stopped/ended — fine */
      }
    });
    liveNodesRef.current.clear();
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

  // Re-phase beat "1". Beat-locked: pick the detected beat nearest "now" as the 1.
  // Free-run: set the grid origin to "now". Tap this on the song's downbeat.
  function setBeatOne() {
    const beats = beatTimesRef.current;
    if (beatLockActive() && beats) {
      const pos = transportRef.current.position;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < beats.length; i++) {
        const d = Math.abs(beats[i] - pos);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      beatOriginRef.current = best;
      return;
    }
    gridBaseRef.current = transportRef.current.position;
    if (runningRef.current) anchorSync();
  }

  // ÷2 / ×2 octave fixups. Beat-locked: re-derive the working beat grid (thin /
  // subdivide) so it stays locked to the music. Free-run: just scale the BPM.
  function applyOctave(factor: number) {
    const base = detectedBeatsRef.current;
    if (sync && canSync && base && base.length > 1) {
      const next = Math.min(4, Math.max(0.25, octaveRef.current * factor));
      octaveRef.current = next;
      const working = octaveBeats(base, next);
      beatTimesRef.current = working;
      beatOriginRef.current = 0;
      setHasBeats(working.length > 0);
      if (detectedBpmRef.current > 0) setBpm(clampBpm(detectedBpmRef.current * next));
      if (runningRef.current) anchorSync();
    } else {
      setBpm((b) => clampBpm(b * factor));
    }
  }

  async function detect() {
    if (!onDetectBeats || detecting) return;
    const forSongId = songIdRef.current; // the analysis belongs to THIS song
    setDetecting(true);
    try {
      const res = await onDetectBeats();
      if (forSongId !== songIdRef.current) return; // song switched mid-analysis —
      // these are the OLD song's beats; keep the grid the song?.id effect cleared
      if (res && res.bpm > 0 && res.beats.length > 1) {
        // beat-locked: schedule clicks on the real beat times (no drift, auto-phase)
        detectedBpmRef.current = res.bpm;
        detectedBeatsRef.current = res.beats;
        octaveRef.current = 1;
        beatTimesRef.current = res.beats.slice();
        beatOriginRef.current = 0;
        setBpm(clampBpm(res.bpm));
        setHasBeats(true);
        if (runningRef.current) anchorSync();
        toast.success(`ล็อกจังหวะเพลงแล้ว ~${clampBpm(res.bpm)} BPM`, {
          description: "เมโทรนอมจะเกาะจังหวะจริงของเพลง • ถี่/ห่างไปกด ÷2 หรือ ×2 • “ตั้งบีตแรก” จัดเลข 1",
        });
      } else if (res && res.bpm > 0) {
        // tempo only — couldn't lock beats; fall back to a free-run clock at this BPM
        detectedBeatsRef.current = null;
        detectedBpmRef.current = 0;
        beatTimesRef.current = null;
        octaveRef.current = 1;
        setHasBeats(false);
        setBpm(clampBpm(res.bpm));
        if (runningRef.current) anchorSync();
        toast.success(`ตรวจจับได้ ~${clampBpm(res.bpm)} BPM`, {
          description: "ล็อกบีตไม่ชัด ใช้จังหวะคงที่แทน • ถ้าเร็ว/ช้าไปเท่าตัวกด ÷2 หรือ ×2",
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

      {/* auto beat detection from the song's audio (+ octave fixups) */}
      {canSync && onDetectBeats && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={detect} disabled={detecting}>
              {detecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {detecting ? "กำลังตรวจจับ…" : "ตรวจจับจังหวะจากเพลง"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyOctave(0.5)} title="ช้าลงครึ่งหนึ่ง">
              ÷2
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyOctave(2)} title="เร็วขึ้นเท่าตัว">
              ×2
            </Button>
          </div>
          {hasBeats && isSync && (
            <p className="flex items-center gap-1 text-xs font-medium text-primary">
              <Crosshair className="h-3 w-3" /> เกาะจังหวะจริงของเพลง — ไม่หลุดจังหวะ
            </p>
          )}
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
            นับ 1–{beats} 🎀
          </button>
        </div>
        {mode === "voice" && <span className="text-xs text-muted-foreground">เสียงสาวญี่ปุ่น</span>}
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
