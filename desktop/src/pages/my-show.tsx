// MY SHOW (โหมดโชว์เดี่ยว) — the fully-LOCAL standalone show runner.
//
// พี่'s design call (2026-07-02): a special Live Mode that needs NO login, NO
// event, NO network — "ออฟไลน์เน้น ๆ แบบโง่ ๆ ทุกอย่างจบบนเครื่องตัวเอง". Songs,
// order, timings and the saved last-run all live in this machine's IndexedDB
// (~/lib/solo-store) and never leave it. This is the Mix Go 16 replacement for
// anyone who just wants to press play with a REAL show clock.
//
// The timing core is a single-device port of components/event/live-mode.tsx —
// same state machine (running/begun/startedAt/itemStartedAt/itemElapsedAtPause/
// currentIndex/mode), same Manual-cue-then-commit and Auto-advance semantics,
// same crash-restore, wake lock, per-track volume + fade buttons, opt-in
// crossfade, and the same output-device lock (SHARED localStorage keys, so the
// machine keeps one output/crossfade preference across both modes). Everything
// multi-device (realtime channel, controller/viewer, authority) is gone — one
// machine is the whole show here, which is exactly the point.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Flag,
  FolderOpen,
  GripVertical,
  Hand,
  Loader2,
  Mic2,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  Repeat,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  Timer,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AudioOutputPicker, AUDIO_SINK_KEY, loadAudioSink } from "@/components/event/audio-output-picker";
import { cn } from "@/lib/utils";
import { formatCountdown, formatDuration, nowClock } from "@/lib/time";
import {
  deleteSoloItem,
  getSoloLastRun,
  listSoloItems,
  putSoloItem,
  putSoloItems,
  setSoloLastRun,
  soloStorageBytes,
  type SoloItem,
} from "~/lib/solo-store";

type ShowMode = "manual" | "auto";

interface ShowState {
  running: boolean;
  begun: boolean;
  startedAt: number | null; // first run — drives accumulated time
  itemStartedAt: number | null;
  itemElapsedAtPause: number | null;
  currentIndex: number;
  mode: ShowMode;
}

const INITIAL: ShowState = {
  running: false,
  begun: false,
  startedAt: null,
  itemStartedAt: null,
  itemElapsedAtPause: null,
  currentIndex: 0,
  mode: "manual",
};

const LIVE_SNAPSHOT_KEY = "cueiq:solo:live";

function blockSeconds(it: SoloItem) {
  return (it.durationSeconds || 0) + (it.bufferAfterSeconds || 0);
}

function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** "3:45" → 225; a plain number is taken as seconds. null = unparseable. */
function parseMmss(v: string): number | null {
  const t = v.trim();
  const m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}

/** The audio length of a picked file, via a throwaway element (0 if undecodable). */
function detectDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    a.preload = "metadata";
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration) : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function MyShow() {
  const [items, setItems] = useState<SoloItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<ShowState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [storageBytes, setStorageBytes] = useState(0);
  const [lastRun, setLastRun] = useState<{ seconds: number; at: number } | null>(null);

  // audio — primary drives the scrubber; secondary carries the crossfade tail
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioRef2 = useRef<HTMLAudioElement | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playingIdRef = useRef(playingId);
  playingIdRef.current = playingId;
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;
  const fadeRef = useRef<number | null>(null);
  const [sinkId, setSinkId] = useState("");
  const sinkLoadedRef = useRef(false);
  const [crossfade, setCrossfade] = useState(false);
  const autoAdvanceForRef = useRef<string | null>(null);

  const addInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  // ---- boot: items + last-run + prefs -----------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const [list, lr, bytes] = await Promise.all([
        listSoloItems(),
        getSoloLastRun(),
        soloStorageBytes(),
      ]);
      if (!alive) return;
      setItems(list);
      setLastRun(lr);
      setStorageBytes(bytes);
      const u: Record<string, string> = {};
      const v: Record<string, number> = {};
      for (const it of list) {
        if (it.blob) u[it.id] = URL.createObjectURL(it.blob);
        v[it.id] = it.volume ?? 100;
      }
      setUrls(u);
      setVolumes(v);
      setLoaded(true);
    })();
    return () => {
      alive = false;
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem("cueiq:crossfade") === "1") setCrossfade(true);
      setSinkId(loadAudioSink());
    } catch {
      /* ignore */
    }
    sinkLoadedRef.current = true;
  }, []);

  // ticking clock (same cadence as Live Mode)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // two audio elements — create once (mirrors live-mode)
  useEffect(() => {
    const make = () => {
      const a = new Audio();
      a.addEventListener("ended", () => {
        if (a === audioRef.current) {
          setPlayingId(null);
          setAudioPlaying(false);
        }
      });
      a.addEventListener("timeupdate", () => {
        if (a !== audioRef.current) return;
        setAudioCurrent(a.currentTime);
        if (a.playbackRate !== 1) a.playbackRate = 1;
      });
      a.addEventListener("loadedmetadata", () => {
        if (a === audioRef.current) setAudioDuration(a.duration);
      });
      return a;
    };
    const a = make();
    const b = make();
    audioRef.current = a;
    audioRef2.current = b;
    return () => {
      a.pause();
      a.src = "";
      b.pause();
      b.src = "";
      audioRef.current = null;
      audioRef2.current = null;
    };
  }, []);

  // output routing — SAME key as Live Mode so the machine has one preference
  useEffect(() => {
    if (sinkLoadedRef.current) {
      try {
        localStorage.setItem(AUDIO_SINK_KEY, sinkId);
      } catch {
        /* ignore */
      }
    }
    const route = (a: HTMLAudioElement | null) => {
      const el = a as
        | (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
        | null;
      if (!el?.setSinkId) return;
      el.setSinkId(sinkId).catch(() => el.setSinkId!("").catch(() => {}));
    };
    route(audioRef.current);
    route(audioRef2.current);
  }, [sinkId]);

  // playing track's preset volume follows the primary element
  useEffect(() => {
    if (!audioRef.current || !playingId) return;
    const v = (volumes[playingId] ?? 100) / 100;
    audioRef.current.volume = Math.min(1, Math.max(0, v));
  }, [volumes, playingId]);

  // persist a settled volume back onto its item (debounced; survives restart)
  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      const changed = itemsRef.current.filter(
        (it) => (volumes[it.id] ?? 100) !== (it.volume ?? 100)
      );
      if (changed.length === 0) return;
      const next = itemsRef.current.map((it) =>
        changed.some((c) => c.id === it.id) ? { ...it, volume: volumes[it.id] ?? 100 } : it
      );
      setItems(next);
      putSoloItems(next.filter((it) => changed.some((c) => c.id === it.id))).catch(() => {});
    }, 600);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumes, loaded]);

  // crash/reload recovery — same contract as Live Mode (fresh within 6h)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!loaded || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(LIVE_SNAPSHOT_KEY);
      if (raw) {
        const snap = JSON.parse(raw);
        const fresh =
          typeof snap?.savedAt === "number" &&
          Date.now() - snap.savedAt < 6 * 60 * 60 * 1000;
        if (snap?.state?.begun && fresh) {
          const s = snap.state as ShowState;
          s.currentIndex = Math.min(s.currentIndex, Math.max(0, itemsRef.current.length - 1));
          setState(s);
          toast.message("กู้คืนสถานะโชว์ที่ค้างไว้", {
            description: "เวลาเดินต่อจากเดิม — กดรีเซ็ตถ้าจะเริ่มใหม่",
          });
        }
      }
    } catch {
      /* ignore */
    }
  }, [loaded]);

  useEffect(() => {
    if (!restoredRef.current) return;
    const id = setTimeout(() => {
      try {
        if (state.begun) {
          localStorage.setItem(
            LIVE_SNAPSHOT_KEY,
            JSON.stringify({ state, savedAt: Date.now() })
          );
        } else {
          localStorage.removeItem(LIVE_SNAPSHOT_KEY);
        }
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(id);
  }, [state]);

  // wake lock while running (+ re-acquire on tab return) — same as Live Mode
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    const acquire = () => {
      navigator.wakeLock
        ?.request("screen")
        .then((wl) => {
          wl.addEventListener("release", () => {
            if (wakeLockRef.current === wl) wakeLockRef.current = null;
          });
          wakeLockRef.current = wl;
        })
        .catch(() => {});
    };
    if (!state.running) {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      return;
    }
    acquire();
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        stateRef.current.running &&
        !wakeLockRef.current
      )
        acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [state.running]);

  // ---- audio helpers (single device — the sounding track is always local) -----
  function playItemAudio(it: SoloItem) {
    const audio = audioRef.current;
    if (!audio) return;
    const url = urls[it.id];
    if (it.kind === "song" && url) {
      if (playingId === it.id && !audio.paused) {
        setAudioPlaying(true);
        return;
      }
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      setPlayingId(it.id);
      setAudioPlaying(true);
    } else {
      // break/MC (or missing file) — stop whatever was playing
      audio.pause();
      setPlayingId(null);
      setAudioPlaying(false);
      setAudioCurrent(0);
      setAudioDuration(0);
    }
  }

  // crossfade (opt-in) — port of live-mode's crossfadeSwap, same guards
  const outFadeTokenRef = useRef(0);
  function crossfadeSwap(itemId: string, url: string, fromOffset = 0) {
    const incoming = audioRef2.current;
    if (!incoming || !audioRef.current) return;
    incoming.pause();
    incoming.src = url;
    incoming.currentTime = Math.max(0, fromOffset);
    incoming.volume = Math.min(1, Math.max(0, (volumesRef.current[itemId] ?? 100) / 100));
    incoming.play().catch(() => {});
    // swap: incoming → primary (scrubber follows it); outgoing → secondary
    const tmp = audioRef.current;
    audioRef.current = audioRef2.current;
    audioRef2.current = tmp;
    const p = audioRef.current;
    if (p) {
      setAudioCurrent(p.currentTime);
      setAudioDuration(isFinite(p.duration) ? p.duration : 0);
    }
    setPlayingId(itemId);
    setAudioPlaying(true);
    const el = audioRef2.current;
    if (!el || el.paused) return;
    const token = ++outFadeTokenRef.current;
    const srcAtStart = el.src;
    const startVol = el.volume;
    const t0 = performance.now();
    const MS = 2000;
    const step = (t: number) => {
      if (outFadeTokenRef.current !== token) return;
      if (el !== audioRef2.current || el.src !== srcAtStart) return;
      const pgs = Math.min(1, (t - t0) / MS);
      el.volume = startVol * (1 - pgs);
      if (pgs < 1) requestAnimationFrame(step);
      else el.pause();
    };
    requestAnimationFrame(step);
  }

  // fade ONE track's volume (fade buttons + loop end-fade); imperative like live-mode
  function fadeVolumeFor(itemId: string, target: number, ms: number) {
    if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
    const start = volumesRef.current[itemId] ?? 100;
    if (ms <= 0 || start === target) {
      setVolumes((prev) => ({ ...prev, [itemId]: target }));
      return;
    }
    const t0 = performance.now();
    let lastSet = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const v = Math.round(start + (target - start) * p);
      if (playingIdRef.current === itemId && audioRef.current) {
        audioRef.current.volume = Math.min(1, Math.max(0, v / 100));
      }
      if (p >= 1 || t - lastSet >= 80) {
        lastSet = t;
        setVolumes((prev) => ({ ...prev, [itemId]: v }));
      }
      fadeRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    fadeRef.current = requestAnimationFrame(step);
  }
  useEffect(() => () => {
    if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
  }, []);

  function fadeVolumeTo(target: number, ms = 2000) {
    const cur = items[state.currentIndex];
    if (!cur) return;
    fadeVolumeFor(cur.id, target, ms);
  }

  // native loop flag follows the sounding item
  useEffect(() => {
    const playing = items.find((it) => it.id === playingId);
    if (audioRef.current) audioRef.current.loop = !!playing?.loop;
  }, [playingId, items]);

  // ---- show controls (ported semantics) ----------------------------------------
  const current = items[state.currentIndex];
  const next = items[state.currentIndex + 1];

  const elapsedItem =
    state.running && state.itemStartedAt
      ? (now - state.itemStartedAt) / 1000
      : (state.itemElapsedAtPause ?? 0);
  const remaining = current ? blockSeconds(current) - elapsedItem : 0;
  const totalElapsed = state.startedAt ? (now - state.startedAt) / 1000 : 0;
  const plannedTotal = useMemo(
    () => items.reduce((s, it) => s + blockSeconds(it), 0),
    [items]
  );

  const zone: "over" | "red" | "amber" | "ok" = !state.running
    ? "ok"
    : remaining <= 0
      ? "over"
      : remaining <= 120
        ? "red"
        : remaining <= 300
          ? "amber"
          : "ok";
  const zoneClasses = {
    over: "bg-destructive text-destructive-foreground animate-pulse-ring",
    red: "bg-destructive text-destructive-foreground",
    amber: "bg-warning text-warning-foreground",
    ok: "bg-card text-foreground",
  }[zone];

  function start() {
    const ts = Date.now();
    setState({
      running: true,
      begun: true,
      startedAt: ts,
      itemStartedAt: ts,
      itemElapsedAtPause: null,
      currentIndex: 0,
      mode: state.mode,
    });
    const first = items[0];
    if (first) playItemAudio(first);
  }

  function toggleShowRun() {
    const audio = audioRef.current;
    const cur = items[state.currentIndex];
    if (state.running) {
      const frozen = state.itemStartedAt
        ? (Date.now() - state.itemStartedAt) / 1000
        : (state.itemElapsedAtPause ?? 0);
      setState({ ...state, running: false, itemElapsedAtPause: frozen });
      audio?.pause();
      audioRef2.current?.pause();
      setAudioPlaying(false);
    } else {
      const offset = state.itemElapsedAtPause ?? 0;
      setState({
        ...state,
        running: true,
        itemStartedAt: Date.now() - offset * 1000,
        itemElapsedAtPause: null,
        startedAt: state.startedAt ?? Date.now(),
      });
      if (cur && audio) {
        const url = urls[cur.id];
        if (playingId === cur.id) {
          if (url) {
            audio.play().catch(() => {});
            setAudioPlaying(true);
          }
        } else if (cur.kind === "song" && url) {
          if (crossfade && !audio.paused && playingId && playingId !== cur.id) {
            crossfadeSwap(cur.id, url, offset);
          } else {
            audio.src = url;
            audio.currentTime = Math.max(0, offset);
            setPlayingId(cur.id);
            audio.play().catch(() => {});
            setAudioPlaying(true);
          }
        } else {
          audio.pause();
          setPlayingId(null);
          setAudioPlaying(false);
        }
      }
    }
  }

  function goto(index: number) {
    if (index < 0 || index >= items.length) return;
    if (state.begun && index === state.currentIndex) return;
    const it = items[index];

    // returning to the SOUNDING track — sync the countdown to its real position
    if (state.begun && it && it.id === playingId && audioRef.current) {
      const audio = audioRef.current;
      const pos = audio.currentTime;
      const playing = !audio.paused;
      setState({
        ...state,
        currentIndex: index,
        itemStartedAt: playing ? Date.now() - pos * 1000 : null,
        itemElapsedAtPause: playing ? null : pos,
        running: playing,
      });
      return;
    }
    if (state.mode === "auto") {
      setState({
        ...state,
        currentIndex: index,
        itemStartedAt: Date.now(),
        itemElapsedAtPause: null,
        running: true,
        startedAt: state.startedAt ?? Date.now(),
      });
      if (it) {
        const url = urls[it.id];
        const a = audioRef.current;
        if (crossfade && it.kind === "song" && url && a && !a.paused && playingId !== it.id) {
          crossfadeSwap(it.id, url);
        } else {
          playItemAudio(it);
        }
      }
    } else {
      // Manual: cue frozen; the previous track keeps playing until committed
      setState({
        ...state,
        currentIndex: index,
        itemStartedAt: null,
        itemElapsedAtPause: 0,
        running: false,
      });
    }
  }

  function setMode(mode: ShowMode) {
    if (mode === "auto" && state.begun) {
      // Auto resumes the SOUNDING track (not a merely-cued row) — same as Live Mode
      const audio = audioRef.current;
      const soundIdx = playingId ? items.findIndex((it) => it.id === playingId) : -1;
      const idx = soundIdx >= 0 ? soundIdx : state.currentIndex;
      const cur = items[idx];
      const offset =
        soundIdx >= 0 && audio
          ? audio.currentTime
          : state.running
            ? state.itemStartedAt
              ? (Date.now() - state.itemStartedAt) / 1000
              : 0
            : (state.itemElapsedAtPause ?? 0);
      setState({
        ...state,
        mode,
        currentIndex: idx,
        running: true,
        itemStartedAt: Date.now() - offset * 1000,
        itemElapsedAtPause: null,
        startedAt: state.startedAt ?? Date.now(),
      });
      const url = cur ? urls[cur.id] : undefined;
      if (cur && cur.kind === "song" && url && audio) {
        if (playingId !== cur.id) {
          audio.src = url;
          audio.currentTime = Math.max(0, offset);
          setPlayingId(cur.id);
        }
        audio.play().catch(() => {});
        setAudioPlaying(true);
      }
    } else {
      setState({ ...state, mode });
    }
  }

  function reset() {
    if (
      state.begun &&
      !window.confirm(
        "รีเซ็ตโชว์? ตำแหน่งและเวลาจะเริ่มใหม่ทั้งหมด\n(ถ้าต้องการเก็บเวลาโชว์ ให้กด “จบโชว์” ก่อน)"
      )
    )
      return;
    audioRef.current?.pause();
    audioRef2.current?.pause();
    autoAdvanceForRef.current = null;
    setPlayingId(null);
    setAudioPlaying(false);
    setAudioCurrent(0);
    setAudioDuration(0);
    setState({ ...INITIAL, mode: state.mode });
  }

  function endShow() {
    const s = stateRef.current;
    const seconds = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
    const rec = { seconds, at: Date.now() };
    setLastRun(rec);
    setSoloLastRun(rec).catch(() => {});
    if (s.running) {
      const frozen = s.itemStartedAt
        ? (Date.now() - s.itemStartedAt) / 1000
        : (s.itemElapsedAtPause ?? 0);
      setState({ ...s, running: false, itemElapsedAtPause: frozen });
      audioRef.current?.pause();
      audioRef2.current?.pause();
      setAudioPlaying(false);
    }
    toast.success(`บันทึกเวลาโชว์ล่าสุด ${formatDuration(seconds)} แล้ว`);
  }

  function clearLastRun() {
    setLastRun(null);
    setSoloLastRun(null).catch(() => {});
  }

  // Auto: advance when the countdown reaches 0 (never when the file ends)
  useEffect(() => {
    if (state.mode !== "auto" || !state.running) return;
    const cur = items[state.currentIndex];
    if (!cur) return;
    if (state.currentIndex >= items.length - 1) return;
    if (remaining > 0) return;
    if (autoAdvanceForRef.current === cur.id) return;
    autoAdvanceForRef.current = cur.id;
    goto(state.currentIndex + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, state, remaining, items]);
  useEffect(() => {
    autoAdvanceForRef.current = null;
  }, [state.currentIndex]);

  // loop items: fade out over the last 3s so they end right on time (Live Mode port)
  const loopFadeRef = useRef<{ id: string; prevVol: number } | null>(null);
  useEffect(() => {
    const cur = items[state.currentIndex];
    const sounding = !!cur && cur.id === playingId;
    if (
      cur &&
      cur.loop &&
      sounding &&
      state.running &&
      audioPlaying &&
      remaining > 0 &&
      remaining <= 3 &&
      loopFadeRef.current?.id !== cur.id
    ) {
      loopFadeRef.current = { id: cur.id, prevVol: volumesRef.current[cur.id] ?? 100 };
      fadeVolumeTo(0, Math.max(200, Math.round(remaining * 1000)));
    }
    if (loopFadeRef.current && (loopFadeRef.current.id !== playingId || !state.running)) {
      const { id, prevVol } = loopFadeRef.current;
      loopFadeRef.current = null;
      fadeVolumeFor(id, prevVol, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, remaining, playingId, state.running, audioPlaying]);

  // scrubber (Manual): drag moves the head; release re-locks the countdown
  function seekAudio(e: React.ChangeEvent<HTMLInputElement>) {
    if (!audioRef.current) return;
    if (playingId !== items[state.currentIndex]?.id) return;
    audioRef.current.currentTime = Number(e.target.value);
  }
  function commitSeek() {
    const audio = audioRef.current;
    const cur = items[state.currentIndex];
    if (!audio || !cur || playingId !== cur.id) return;
    const pos = audio.currentTime;
    if (state.running) {
      setState({ ...state, itemStartedAt: Date.now() - pos * 1000, itemElapsedAtPause: null });
    } else {
      setState({ ...state, itemStartedAt: null, itemElapsedAtPause: pos });
    }
  }

  // resume audio after a reload/autoplay block — the tap supplies the gesture
  const needsAudioResume =
    state.running &&
    !audioPlaying &&
    !!current &&
    current.kind === "song" &&
    !!urls[current.id];
  function resumeAudio() {
    const audio = audioRef.current;
    const cur = items[state.currentIndex];
    const url = cur ? urls[cur.id] : undefined;
    if (!audio || !cur || !url) return;
    const pos = state.itemStartedAt ? (Date.now() - state.itemStartedAt) / 1000 : 0;
    if (playingId !== cur.id) audio.src = url;
    audio.currentTime = Math.max(0, pos);
    setPlayingId(cur.id);
    audio
      .play()
      .then(() => setAudioPlaying(true))
      .catch(() => {});
  }

  // keyboard: Space start/run-pause · →/N next · ← back (Manual)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable)
      return;
    const s = stateRef.current;
    const n = itemsRef.current.length;
    if (e.code === "Space") {
      e.preventDefault();
      if (!s.begun) start();
      else toggleShowRun();
    } else if (e.key === "ArrowRight" || e.key === "n" || e.key === "N") {
      if (s.begun && s.mode === "manual" && s.currentIndex < n - 1) {
        e.preventDefault();
        goto(s.currentIndex + 1);
      }
    } else if (e.key === "ArrowLeft") {
      if (s.begun && s.mode === "manual" && s.currentIndex > 0) {
        e.preventDefault();
        goto(s.currentIndex - 1);
      }
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- editing (persist straight to IndexedDB) ---------------------------------
  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAdding(true);
    try {
      const base = itemsRef.current.length
        ? Math.max(...itemsRef.current.map((i) => i.sortOrder)) + 1
        : 1;
      const added: SoloItem[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const dur = await detectDuration(f);
        added.push({
          id: newId(),
          kind: "song",
          title: f.name.replace(/\.[a-z0-9]+$/i, ""),
          fileName: f.name,
          blob: f,
          durationSeconds: dur,
          bufferAfterSeconds: 0,
          loop: false,
          volume: 100,
          sortOrder: base + i,
        });
      }
      await putSoloItems(added);
      setItems((prev) => [...prev, ...added]);
      setUrls((prev) => {
        const n = { ...prev };
        for (const it of added) if (it.blob) n[it.id] = URL.createObjectURL(it.blob);
        return n;
      });
      setVolumes((prev) => {
        const n = { ...prev };
        for (const it of added) n[it.id] = 100;
        return n;
      });
      soloStorageBytes().then(setStorageBytes).catch(() => {});
    } catch (err) {
      toast.error("เพิ่มเพลงไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAdding(false);
    }
  }

  async function addBreak() {
    const base = itemsRef.current.length
      ? Math.max(...itemsRef.current.map((i) => i.sortOrder)) + 1
      : 1;
    const it: SoloItem = {
      id: newId(),
      kind: "break",
      title: "MC / พัก",
      fileName: null,
      blob: null,
      durationSeconds: 300,
      bufferAfterSeconds: 0,
      loop: false,
      volume: 100,
      sortOrder: base,
    };
    await putSoloItem(it).catch(() => {});
    setItems((prev) => [...prev, it]);
    setEditing(true);
  }

  async function updateItem(id: string, partial: Partial<SoloItem>) {
    const cur = itemsRef.current.find((i) => i.id === id);
    if (!cur) return;
    const next = { ...cur, ...partial };
    setItems((prev) => prev.map((i) => (i.id === id ? next : i)));
    await putSoloItem(next).catch(() => {});
  }

  async function removeItem(id: string) {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    if (!window.confirm(`ลบ “${it.title}” ออกจากโชว์? ไฟล์ที่เก็บไว้ในเครื่องจะถูกลบด้วย`)) return;
    if (id === playingId) {
      audioRef.current?.pause();
      setPlayingId(null);
      setAudioPlaying(false);
    }
    const url = urls[id];
    if (url) URL.revokeObjectURL(url);
    setUrls((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    const curId = itemsRef.current[stateRef.current.currentIndex]?.id;
    const nextList = itemsRef.current.filter((i) => i.id !== id);
    setItems(nextList);
    if (curId) {
      const newIdx = nextList.findIndex((i) => i.id === curId);
      setState((prev) => ({
        ...prev,
        currentIndex:
          newIdx >= 0 ? newIdx : Math.min(prev.currentIndex, Math.max(0, nextList.length - 1)),
      }));
    }
    await deleteSoloItem(id).catch(() => {});
    soloStorageBytes().then(setStorageBytes).catch(() => {});
  }

  async function reorderTo(from: number, to: number) {
    if (from === to) return;
    const arr = [...itemsRef.current];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const renumbered = arr.map((it, i) => ({ ...it, sortOrder: i + 1 }));
    const curId = itemsRef.current[stateRef.current.currentIndex]?.id;
    setItems(renumbered);
    if (curId) {
      const newIdx = renumbered.findIndex((it) => it.id === curId);
      if (newIdx >= 0 && newIdx !== stateRef.current.currentIndex) {
        setState((p) => ({ ...p, currentIndex: newIdx }));
      }
    }
    await putSoloItems(renumbered).catch(() => {});
  }

  function replaceFile(itemId: string) {
    replaceTargetRef.current = itemId;
    replaceInputRef.current?.click();
  }
  async function handleReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const id = replaceTargetRef.current;
    e.target.value = "";
    if (!f || !id) return;
    const dur = await detectDuration(f);
    const old = urls[id];
    if (old && id !== playingId) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(f);
    setUrls((prev) => ({ ...prev, [id]: url }));
    await updateItem(id, {
      kind: "song",
      blob: f,
      fileName: f.name,
      durationSeconds: dur,
    });
    soloStorageBytes().then(setStorageBytes).catch(() => {});
  }

  const wallClock = useMemo(() => nowClock(new Date(now)), [now]);
  const currentUrl = current ? urls[current.id] : undefined;

  // ---- render -------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <input
          ref={addInputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={replaceInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleReplaceFile}
        />

        <div className="flex items-center justify-between gap-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/login">
              <ArrowLeft className="h-4 w-4" /> กลับหน้าเข้าสู่ระบบ
            </Link>
          </Button>
          <span className="text-[11px] text-muted-foreground">
            เก็บในเครื่องนี้เท่านั้น · {items.length} รายการ
            {storageBytes > 0 ? ` · ${Math.round(storageBytes / 1048576)} MB` : ""}
          </span>
        </div>

        {/* top bar — wall clock (mirrors Live Mode) */}
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 font-medium">
            <Radio
              className={cn(
                "h-4 w-4 shrink-0",
                state.running ? "text-destructive" : "text-muted-foreground"
              )}
            />
            <span className="truncate">My Show</span>
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
              โหมดโชว์เดี่ยว · ออฟไลน์ 100%
            </span>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-muted-foreground">เวลาจริง</p>
            <p className="font-semibold tabular-nums">{wallClock}</p>
          </div>
        </div>

        {needsAudioResume && (
          <button
            onClick={resumeAudio}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400 bg-amber-500 px-4 py-3 text-base font-bold text-black shadow-sm animate-pulse hover:bg-amber-400"
          >
            <Volume2 className="h-5 w-5" /> แตะเพื่อเล่นเสียงต่อ (ตำแหน่งปัจจุบัน)
          </button>
        )}

        {items.length === 0 && loaded ? (
          <button
            type="button"
            onClick={() => addInputRef.current?.click()}
            className="w-full rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground hover:bg-muted/40"
          >
            <FolderOpen className="mx-auto mb-2 h-7 w-7" />
            แตะเพื่อเลือกไฟล์เพลงจากเครื่องนี้ (เลือกได้หลายไฟล์)
            <br />
            <span className="text-xs">เพลงจะถูกเก็บไว้ในเครื่อง เปิดโปรแกรมใหม่ก็ยังอยู่</span>
          </button>
        ) : (
          <>
            {/* main countdown card */}
            <div
              className={cn(
                "rounded-2xl border p-6 text-center shadow-sm transition-colors",
                zoneClasses
              )}
            >
              <div className="mb-1 flex items-center justify-center gap-2">
                {current && (
                  <Badge variant="secondary" className="bg-black/10">
                    {current.kind === "break" ? "MC" : "เพลง"}
                  </Badge>
                )}
                <span className="text-sm opacity-80 tabular-nums">
                  {state.currentIndex + 1} / {items.length}
                </span>
              </div>
              <h2 className="mb-3 break-words px-1 text-xl font-bold leading-tight sm:text-2xl">
                {current?.title || "—"}
              </h2>
              <p className="text-5xl font-bold tabular-nums sm:text-6xl">
                {formatCountdown(Math.round(remaining))}
              </p>
              <p className="mt-2 text-sm opacity-80">
                {zone === "over"
                  ? "เลยเวลาแล้ว"
                  : zone === "red"
                    ? "เหลือน้อยกว่า 2 นาที"
                    : zone === "amber"
                      ? "เหลือน้อยกว่า 5 นาที"
                      : "เวลาคงเหลือของรายการ"}
              </p>

              {/* audio scrubber + volume + fade buttons */}
              {current && current.kind === "song" && currentUrl && (
                <div className="mt-4 w-full space-y-1.5 rounded-lg bg-black/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      title={state.running ? "กำลังเล่น (คุมที่ปุ่มรันโชว์)" : "หยุดอยู่ (กดรันโชว์เพื่อเล่น)"}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white/80"
                    >
                      {state.running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={audioDuration || 1}
                      step={0.1}
                      value={playingId === current.id ? audioCurrent : 0}
                      onChange={seekAudio}
                      onPointerUp={commitSeek}
                      onKeyUp={commitSeek}
                      disabled={state.mode === "auto"}
                      title={state.mode === "auto" ? "Auto: เลื่อนเวลาเพลงไม่ได้" : "เลื่อนเวลาเพลง"}
                      className={cn(
                        "h-1.5 flex-1 accent-white",
                        state.mode === "auto" ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                      )}
                    />
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums opacity-80">
                      {playingId === current.id
                        ? `${fmtTime(audioCurrent)} / ${fmtTime(audioDuration)}`
                        : fmtTime(audioDuration)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Volume1 className="h-4 w-4 shrink-0 opacity-80" />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={volumes[current.id] ?? 100}
                      onChange={(e) => fadeVolumeFor(current.id, Number(e.target.value), 0)}
                      title="ความดังของแทร็คนี้ (จำค่าไว้ให้)"
                      className="h-1.5 flex-1 cursor-pointer accent-white"
                    />
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums opacity-80">
                      {volumes[current.id] ?? 100}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => fadeVolumeTo(0, 3000)}
                      title="ค่อย ๆ ปิดเสียงเป็น 0% ใน 3 วินาที"
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-rose-600/85 py-3 text-sm font-bold text-white shadow-sm ring-1 ring-rose-400/40 hover:bg-rose-600"
                    >
                      <VolumeX className="h-4 w-4" /> Auto Mute
                    </button>
                    <button
                      onClick={() => fadeVolumeTo(30)}
                      title="ค่อย ๆ ลดเสียงเป็น 30% (ช่วง MC)"
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-amber-400/90 py-3 text-sm font-bold text-black shadow-sm ring-1 ring-amber-300/50 hover:bg-amber-400"
                    >
                      <Volume1 className="h-4 w-4" /> MC
                    </button>
                    <button
                      onClick={() => fadeVolumeTo(100, 2500)}
                      title="ค่อย ๆ เพิ่มเสียงกลับเป็น 100%"
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600/85 py-3 text-sm font-bold text-white shadow-sm ring-1 ring-emerald-400/40 hover:bg-emerald-600"
                    >
                      <Volume2 className="h-4 w-4" /> Auto Loudness
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border bg-card p-4 text-center">
                <p className="text-xs text-muted-foreground">เวลาสะสม (Accumulated)</p>
                <p className="text-2xl font-bold tabular-nums">{formatDuration(totalElapsed)}</p>
              </div>
              <div className="rounded-xl border bg-card p-4 text-center">
                <p className="text-xs text-muted-foreground">รวมตามแผน · ถัดไป</p>
                <p className="truncate text-lg font-semibold">
                  <span className="tabular-nums">{formatDuration(plannedTotal)}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  {next?.title || "— จบโชว์ —"}
                </p>
              </div>
            </div>

            {/* show controls */}
            <div className="rounded-xl border bg-card p-3">
              <div className="mb-2 grid grid-cols-2 gap-2">
                <Button
                  variant={state.mode === "manual" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setMode("manual")}
                >
                  <Hand className="h-4 w-4" /> Manual
                </Button>
                <Button
                  variant={state.mode === "auto" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setMode("auto")}
                >
                  <Sparkles className="h-4 w-4" /> Auto
                </Button>
              </div>

              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextV = !crossfade;
                    setCrossfade(nextV);
                    try {
                      localStorage.setItem("cueiq:crossfade", nextV ? "1" : "0");
                    } catch {
                      /* ignore */
                    }
                  }}
                  title={
                    crossfade
                      ? "Crossfade เปิด — เพลงเดิมเฟดออก ~2 วิ ตอนเปลี่ยนเพลง (แตะเพื่อปิด)"
                      : "Crossfade ปิด — เปลี่ยนเพลงแบบตัดทันที (แตะเพื่อเปิด)"
                  }
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                    crossfade
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  <Volume1 className="h-3.5 w-3.5" /> Crossfade {crossfade ? "เปิด" : "ปิด"}
                </button>
                <AudioOutputPicker value={sinkId} onChange={setSinkId} />
              </div>

              {!state.begun ? (
                <Button size="xl" className="w-full" onClick={start} disabled={items.length === 0}>
                  <Play className="h-5 w-5" /> START SHOW
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={() => goto(state.currentIndex - 1)}
                    disabled={state.mode === "auto" || state.currentIndex === 0}
                    title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "ย้อนกลับ"}
                  >
                    <SkipBack className="h-5 w-5" />
                  </Button>
                  <Button
                    size="lg"
                    onClick={toggleShowRun}
                    className={cn(
                      "min-w-0 shrink font-semibold text-white",
                      state.running
                        ? "bg-green-600 hover:bg-green-700"
                        : "bg-amber-500 hover:bg-amber-600"
                    )}
                  >
                    {state.running ? (
                      <>
                        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white" />
                        กำลังรันโชว์
                      </>
                    ) : (
                      <>
                        <Play className="h-5 w-5" /> รันโชว์ (จับเวลา)
                      </>
                    )}
                  </Button>
                  <Button
                    size="lg"
                    className="min-w-0 flex-1 px-3"
                    onClick={() => goto(state.currentIndex + 1)}
                    disabled={state.mode === "auto" || state.currentIndex >= items.length - 1}
                    title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "รายการถัดไป"}
                  >
                    <SkipForward className="h-5 w-5 shrink-0" /> NEXT
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={reset}
                  >
                    <RotateCcw className="h-5 w-5" />
                  </Button>
                </div>
              )}
              {state.begun && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={endShow}
                  title="หยุดนับเวลาสะสม + บันทึกเป็นเวลาโชว์ล่าสุด (ไม่ใช่รีเซ็ต)"
                >
                  <Flag className="h-4 w-4" /> จบโชว์ · บันทึกเวลาสะสม
                </Button>
              )}
              <p className="mt-2 text-center text-xs text-muted-foreground">
                <Radio className="mr-1 inline h-3 w-3" />
                {state.mode === "auto"
                  ? "Auto: เปลี่ยนรายการเองเมื่อครบเวลา — กด Manual เพื่อคุมเอง"
                  : "Manual: กด NEXT เพื่อข้ามรายการ · Space เริ่ม/หยุด"}
              </p>
            </div>

            {/* setlist — edit-in-place, everything on this one page */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Music2 className="h-4 w-4" /> รายการโชว์
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={addBreak}>
                    <Mic2 className="h-4 w-4" /> เพิ่มช่วง MC
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addInputRef.current?.click()}
                    disabled={adding}
                  >
                    {adding ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    เพิ่มเพลง
                  </Button>
                  <button
                    onClick={() => setEditing((v) => !v)}
                    className={cn(
                      "flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                      editing
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <Pencil className="h-3.5 w-3.5" /> {editing ? "เสร็จ" : "แก้ไข"}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border bg-card">
                {items.map((it, i) => {
                  const isCurrent = i === state.currentIndex;
                  const isPlayingThis = playingId === it.id && audioPlaying;
                  return (
                    <div
                      key={it.id}
                      onDragOver={(e) => {
                        if (dragIndexRef.current !== null) e.preventDefault();
                      }}
                      onDrop={() => {
                        if (dragIndexRef.current !== null && dragIndexRef.current !== i) {
                          reorderTo(dragIndexRef.current, i);
                        }
                        dragIndexRef.current = null;
                      }}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-2 border-b px-3 py-2 last:border-0",
                        isCurrent && "bg-primary/10"
                      )}
                    >
                      <span
                        draggable
                        onDragStart={() => {
                          dragIndexRef.current = i;
                        }}
                        onDragEnd={() => {
                          dragIndexRef.current = null;
                        }}
                        title="ลากเพื่อสลับลำดับ"
                        className="-ml-1 shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <button
                        onClick={() => goto(i)}
                        disabled={state.mode === "auto"}
                        title={
                          state.mode === "auto"
                            ? "Auto mode — สลับเป็น Manual ก่อนถึงจะเลือกเองได้"
                            : undefined
                        }
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 text-left text-sm",
                          state.mode === "auto" && "cursor-default"
                        )}
                      >
                        <span className="w-5 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                          {i + 1}
                        </span>
                        <Badge variant="outline" className="shrink-0">
                          {it.kind === "break" ? "MC" : "เพลง"}
                        </Badge>
                        <span
                          className={cn("min-w-0 flex-1 truncate", isCurrent && "font-medium")}
                        >
                          {it.title || "—"}
                        </span>
                        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                          {formatDuration(blockSeconds(it))}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <div className="flex flex-col">
                          <button
                            onClick={() => reorderTo(i, i - 1)}
                            disabled={i === 0}
                            title="เลื่อนขึ้น"
                            className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => reorderTo(i, i + 1)}
                            disabled={i === items.length - 1}
                            title="เลื่อนลง"
                            className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {isPlayingThis && (
                          <Volume2 className="h-3.5 w-3.5 animate-pulse text-primary" />
                        )}
                        {it.kind === "song" && (
                          <button
                            onClick={() => updateItem(it.id, { loop: !it.loop })}
                            title={
                              it.loop
                                ? "Loop เปิด — วนจนครบเวลาแล้วเฟดจบเอง (แตะเพื่อปิด)"
                                : "Loop ปิด — แตะเพื่อให้วนจนครบเวลา"
                            }
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted",
                              it.loop
                                ? "text-primary"
                                : "text-muted-foreground/40 hover:text-muted-foreground"
                            )}
                          >
                            <Repeat className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {editing && (
                          <>
                            {it.kind === "song" && (
                              <button
                                onClick={() => replaceFile(it.id)}
                                title="เปลี่ยนไฟล์เพลง (ไฟล์ใหม่ทับไฟล์เดิมในเครื่อง)"
                                className="flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-muted"
                              >
                                <FolderOpen className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => removeItem(it.id)}
                              title="ลบออกจากโชว์"
                              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>

                      {/* inline edit row: title · duration · buffer */}
                      {editing && (
                        <div className="flex w-full flex-wrap items-center gap-2 pb-1 pl-8 text-xs">
                          <input
                            defaultValue={it.title}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== it.title) updateItem(it.id, { title: v });
                            }}
                            placeholder="ชื่อรายการ"
                            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2"
                          />
                          <label className="flex items-center gap-1 text-muted-foreground">
                            เวลา
                            <input
                              key={`${it.id}-d${it.durationSeconds}`}
                              defaultValue={fmtTime(it.durationSeconds)}
                              onBlur={(e) => {
                                const sec = parseMmss(e.target.value);
                                if (sec != null && sec !== it.durationSeconds)
                                  updateItem(it.id, { durationSeconds: sec });
                                else e.target.value = fmtTime(it.durationSeconds);
                              }}
                              title="ความยาวช่วงนี้ (นาที:วินาที)"
                              className="h-7 w-16 rounded-md border bg-background px-2 text-center tabular-nums"
                            />
                          </label>
                          <label className="flex items-center gap-1 text-muted-foreground">
                            <Timer className="h-3 w-3" /> เผื่อ
                            <input
                              key={`${it.id}-b${it.bufferAfterSeconds}`}
                              defaultValue={fmtTime(it.bufferAfterSeconds)}
                              onBlur={(e) => {
                                const sec = parseMmss(e.target.value);
                                if (sec != null && sec !== it.bufferAfterSeconds)
                                  updateItem(it.id, { bufferAfterSeconds: sec });
                                else e.target.value = fmtTime(it.bufferAfterSeconds);
                              }}
                              title="เวลาเผื่อต่อท้าย (พูด/เปลี่ยนชุด) — นาที:วินาที"
                              className="h-7 w-16 rounded-md border bg-background px-2 text-center tabular-nums"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* last saved run */}
            {lastRun && (
              <div className="flex items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Timer className="h-3.5 w-3.5" /> เวลาโชว์ล่าสุด (บันทึกไว้)
                  </p>
                  <p className="text-xl font-bold tabular-nums">
                    {formatDuration(lastRun.seconds)}
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                      ·{" "}
                      {new Date(lastRun.at).toLocaleString("th-TH", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearLastRun}
                  className="shrink-0 text-muted-foreground"
                >
                  ล้าง
                </Button>
              </div>
            )}
          </>
        )}

        <p className="px-1 text-center text-[11px] text-muted-foreground">
          ทุกอย่างอยู่ในเครื่องนี้เท่านั้น — ไม่ต้องล็อกอิน ไม่ใช้เน็ต ไม่ส่งข้อมูลไปไหน
        </p>
      </div>
    </div>
  );
}
