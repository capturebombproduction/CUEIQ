"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  Radio,
  FolderOpen,
  Music2,
  Volume2,
  Hand,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  SETLIST_KIND_SHORT,
  type SetlistItem,
  type SetlistKind,
} from "@/lib/types";
import { formatCountdown, formatDuration, nowClock } from "@/lib/time";

type ShowMode = "manual" | "auto";

interface LiveState {
  running: boolean;
  startedAt: number | null;
  itemStartedAt: number | null;
  itemElapsedAtPause: number | null;
  currentIndex: number;
  mode: ShowMode;
}

const INITIAL: LiveState = {
  running: false,
  startedAt: null,
  itemStartedAt: null,
  itemElapsedAtPause: null,
  currentIndex: 0,
  mode: "manual",
};

function blockSeconds(it: SetlistItem) {
  return (
    (it.buffer_before_seconds || 0) +
    (it.duration_seconds || 0) +
    (it.buffer_after_seconds || 0)
  );
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LiveMode({
  eventId,
  eventName,
  items,
}: {
  eventId: string;
  eventName: string;
  items: SetlistItem[];
}) {
  const [state, setState] = useState<LiveState>(INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [syncReady, setSyncReady] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // always-current state for use inside stable callbacks (subscribe, visibilitychange)
  const stateRef = useRef(state);
  stateRef.current = state;
  const meId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random())
  );

  // audio state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadTargetRef = useRef<string | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({}); // itemId → objectURL
  const [audioNames, setAudioNames] = useState<Record<string, string>>({}); // itemId → filename
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  // tracks which "currentId→nextId" pair already had auto-trigger fired
  const autoTriggeredForRef = useRef<string | null>(null);
  // tracks which item already triggered an auto-advance (no-audio items)
  const autoAdvanceForRef = useRef<string | null>(null);

  // ticking clock
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // always-current handler for when the playing audio finishes (auto-advance)
  const onEndedRef = useRef<() => void>(() => {});

  // audio element — create once
  useEffect(() => {
    const audio = new Audio();
    audio.addEventListener("ended", () => {
      setPlayingId(null);
      setAudioPlaying(false);
      onEndedRef.current();
    });
    audio.addEventListener("timeupdate", () => {
      setAudioCurrent(audio.currentTime);
    });
    audio.addEventListener("loadedmetadata", () => {
      setAudioDuration(audio.duration);
    });
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, []);

  // cleanup object URLs on unmount
  const audioUrlsRef = useRef(audioUrls);
  audioUrlsRef.current = audioUrls;
  useEffect(() => {
    return () => {
      Object.values(audioUrlsRef.current).forEach((u) =>
        URL.revokeObjectURL(u)
      );
    };
  }, []);

  // Wake Lock — keep screen on while running
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!state.running) {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      return;
    }
    navigator.wakeLock
      ?.request("screen")
      .then((wl) => {
        // browser nulls the ref when it auto-releases (e.g. tab hidden)
        wl.addEventListener("release", () => {
          if (wakeLockRef.current === wl) wakeLockRef.current = null;
        });
        wakeLockRef.current = wl;
      })
      .catch(() => {});
    return () => {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [state.running]);

  // re-acquire Wake Lock when returning to the tab (browser auto-releases it on hide)
  useEffect(() => {
    function onVisible() {
      if (
        document.visibilityState === "visible" &&
        stateRef.current.running &&
        !wakeLockRef.current
      ) {
        navigator.wakeLock
          ?.request("screen")
          .then((wl) => {
            wl.addEventListener("release", () => {
              if (wakeLockRef.current === wl) wakeLockRef.current = null;
            });
            wakeLockRef.current = wl;
          })
          .catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // reset per-item auto guards when item changes
  useEffect(() => {
    autoTriggeredForRef.current = null;
    autoAdvanceForRef.current = null;
  }, [state.currentIndex]);

  // negative buffer: auto-play next item's audio when remaining ≤ |buffer_before|
  useEffect(() => {
    if (!state.running || !state.itemStartedAt) return;
    const cur = items[state.currentIndex];
    const nxt = items[state.currentIndex + 1];
    if (!cur || !nxt) return;
    const nextBefore = nxt.buffer_before_seconds ?? 0;
    if (nextBefore >= 0) return; // only for negative buffer

    const rem = blockSeconds(cur) - (now - state.itemStartedAt) / 1000;
    const triggerKey = `${cur.id}→${nxt.id}`;
    if (autoTriggeredForRef.current === triggerKey) return;

    if (rem > 0 && rem <= Math.abs(nextBefore)) {
      autoTriggeredForRef.current = triggerKey;
      const url = audioUrls[nxt.id];
      if (url && audioRef.current) {
        const audio = audioRef.current;
        audio.pause();
        audio.src = url;
        audio.currentTime = 0;
        audio.play().catch(() => {});
        setPlayingId(nxt.id);
        setAudioPlaying(true);
      }
    }
  }, [now, state, items, audioUrls]);

  // realtime sync
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`live:${eventId}`, {
      config: { broadcast: { self: false } },
    });
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      setState({
        running: payload.running,
        startedAt: payload.startedAt,
        itemStartedAt: payload.itemStartedAt,
        itemElapsedAtPause: payload.itemElapsedAtPause ?? null,
        currentIndex: payload.currentIndex,
        mode: payload.mode ?? "manual",
      });
    });
    // a device that just joined asks for current state; anyone mid-show replies
    ch.on("broadcast", { event: "sync-request" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      const s = stateRef.current;
      if (s.startedAt != null) {
        ch.send({
          type: "broadcast",
          event: "state",
          payload: { ...s, sender: meId.current },
        });
      }
    });
    // set immediately so SDK can queue messages sent before SUBSCRIBED
    channelRef.current = ch;
    ch.subscribe((status) => {
      const ready = status === "SUBSCRIBED";
      setSyncReady(ready);
      if (ready) {
        // request current show state from any device already running
        ch.send({
          type: "broadcast",
          event: "sync-request",
          payload: { sender: meId.current },
        });
      }
    });
    return () => {
      channelRef.current = null;
      setSyncReady(false);
      supabase.removeChannel(ch);
    };
  }, [eventId]);

  function apply(next: LiveState, broadcast = true) {
    setState(next);
    if (broadcast) {
      channelRef.current?.send({
        type: "broadcast",
        event: "state",
        payload: { ...next, sender: meId.current },
      });
    }
  }

  // audio controls
  function openFilePicker(itemId: string) {
    loadTargetRef.current = itemId;
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const itemId = loadTargetRef.current;
    if (!file || !itemId) return;
    // revoke old URL
    if (audioUrls[itemId]) URL.revokeObjectURL(audioUrls[itemId]);
    const url = URL.createObjectURL(file);
    setAudioUrls((prev) => ({ ...prev, [itemId]: url }));
    setAudioNames((prev) => ({ ...prev, [itemId]: file.name }));
    e.target.value = "";
  }

  function toggleAudio(itemId: string) {
    const url = audioUrls[itemId];
    if (!url || !audioRef.current) return;
    const audio = audioRef.current;

    if (playingId === itemId) {
      if (audio.paused) {
        audio.play().catch(() => {});
        setAudioPlaying(true);
      } else {
        audio.pause();
        setAudioPlaying(false);
      }
    } else {
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      setPlayingId(itemId);
      setAudioPlaying(true);
    }
  }

  function seekAudio(e: React.ChangeEvent<HTMLInputElement>) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Number(e.target.value);
  }

  const current = items[state.currentIndex];
  const next = items[state.currentIndex + 1];

  const elapsedItem = state.running && state.itemStartedAt
    ? (now - state.itemStartedAt) / 1000
    : (state.itemElapsedAtPause ?? 0);
  const remaining = current ? blockSeconds(current) - elapsedItem : 0;
  // accumulated = real elapsed time since show start; keeps counting through pauses
  const totalElapsed = state.startedAt ? (now - state.startedAt) / 1000 : 0;

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

  // Play an item's audio if a file is loaded; otherwise stop current playback.
  function playItemAudio(itemId: string) {
    const url = audioUrls[itemId];
    const audio = audioRef.current;
    if (!audio) return;
    if (url) {
      // already playing this exact item (e.g. started early via negative buffer) — don't restart
      if (playingId === itemId && !audio.paused) {
        setAudioPlaying(true);
        return;
      }
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      setPlayingId(itemId);
      setAudioPlaying(true);
    } else {
      audio.pause();
      setPlayingId(null);
      setAudioPlaying(false);
      setAudioCurrent(0);
      setAudioDuration(0);
    }
  }

  // show-level controls
  function start() {
    const ts = Date.now();
    apply({ running: true, startedAt: ts, itemStartedAt: ts, itemElapsedAtPause: null, currentIndex: 0, mode: state.mode });
    const first = items[0];
    if (first) playItemAudio(first.id);
  }
  function setMode(mode: ShowMode) {
    apply({ ...state, mode });
  }
  function pauseToggle() {
    if (state.running) {
      // pause: freeze item countdown + audio. Accumulated keeps running (derived from startedAt).
      const frozenItem = state.itemStartedAt ? (Date.now() - state.itemStartedAt) / 1000 : 0;
      apply({ ...state, running: false, itemElapsedAtPause: frozenItem });
      audioRef.current?.pause();
      setAudioPlaying(false);
    } else {
      const itemOffset = state.itemElapsedAtPause ?? 0;
      const newItemStart = Date.now() - itemOffset * 1000;
      apply({ ...state, running: true, itemStartedAt: newItemStart, itemElapsedAtPause: null });
      if (playingId && audioRef.current) {
        audioRef.current.play().catch(() => {});
        setAudioPlaying(true);
      }
    }
  }
  function goto(index: number) {
    if (index < 0 || index >= items.length) return;
    // clicking the item that's already current must NOT reset its timer/audio
    if (index === state.currentIndex && state.startedAt != null) return;
    apply({
      ...state,
      currentIndex: index,
      itemStartedAt: Date.now(),
      itemElapsedAtPause: null,
      running: true,
      startedAt: state.startedAt ?? Date.now(),
    });
    const it = items[index];
    if (it) playItemAudio(it.id);
  }
  function reset() {
    audioRef.current?.pause();
    setPlayingId(null);
    setAudioPlaying(false);
    apply({ ...INITIAL, mode: state.mode }); // keep chosen mode after reset
  }

  // in Auto mode, advance to next item when the current item's audio finishes
  onEndedRef.current = () => {
    const s = stateRef.current;
    if (s.mode === "auto" && s.running && s.currentIndex < items.length - 1) {
      goto(s.currentIndex + 1);
    }
  };

  // in Auto mode, advance items WITHOUT an audio file when their countdown hits 0.
  // Only the control device (the one holding audio files) advances; viewers follow via sync.
  useEffect(() => {
    if (state.mode !== "auto" || !state.running) return;
    if (Object.keys(audioUrls).length === 0) return; // viewers don't drive advance
    const cur = items[state.currentIndex];
    if (!cur || audioUrls[cur.id]) return; // items with audio advance on 'ended'
    if (state.currentIndex >= items.length - 1) return;
    if (remaining > 0) return;
    if (autoAdvanceForRef.current === cur.id) return;
    autoAdvanceForRef.current = cur.id;
    goto(state.currentIndex + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, state, remaining, audioUrls, items]);

  const wallClock = useMemo(() => nowClock(new Date(now)), [now]);

  const currentAudioUrl = current ? audioUrls[current.id] : undefined;
  const currentAudioPlaying = current && playingId === current.id && audioPlaying;

  if (items.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-10 text-center text-muted-foreground">
        ยังไม่มีรายการในเซ็ตลิสต์ — เพิ่มเพลงก่อนเริ่ม Live Mode
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* top bar */}
      <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
        <div className="flex items-center gap-2 font-medium">
          <Radio
            className={cn(
              "h-4 w-4",
              state.running ? "text-destructive" : "text-muted-foreground"
            )}
          />
          <span className="truncate">{eventName}</span>
          <span
            title={syncReady ? "Sync ready" : "Connecting…"}
            className={cn(
              "h-2 w-2 rounded-full",
              syncReady ? "bg-green-500" : "animate-pulse bg-yellow-400"
            )}
          />
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">เวลาจริง</p>
          <p className="font-semibold tabular-nums">{wallClock}</p>
        </div>
      </div>

      {/* main countdown */}
      <div
        className={cn(
          "rounded-2xl border p-6 text-center shadow-sm transition-colors",
          zoneClasses
        )}
      >
        <div className="mb-1 flex items-center justify-center gap-2">
          {current && (
            <Badge variant="secondary" className="bg-black/10">
              {SETLIST_KIND_SHORT[current.kind as SetlistKind]}
            </Badge>
          )}
          <span className="text-sm opacity-80 tabular-nums">
            {state.currentIndex + 1} / {items.length}
          </span>
        </div>
        <h2 className="mb-3 break-words px-1 text-xl font-bold leading-tight sm:text-2xl">
          {current?.title || "—"}
        </h2>
        <p className="text-5xl font-black tabular-nums sm:text-6xl lg:text-7xl">
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
        {current && current.mic_slots?.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {current.mic_slots.map((s, i) => (
              <Badge
                key={i}
                variant="outline"
                className="border-black/20 bg-black/5"
              >
                {s.mic} → {s.member}
              </Badge>
            ))}
          </div>
        )}

        {/* Audio player for current item */}
        {current && (
          <div className="mt-4 flex items-center justify-center gap-2">
            {currentAudioUrl ? (
              <div className="w-full space-y-1.5 rounded-lg bg-black/10 px-3 py-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleAudio(current.id)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 hover:bg-white/30"
                  >
                    {currentAudioPlaying ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={audioDuration || 1}
                    step={0.1}
                    value={playingId === current.id ? audioCurrent : 0}
                    onChange={seekAudio}
                    className="h-1.5 flex-1 cursor-pointer accent-white"
                  />
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums opacity-80">
                    {playingId === current.id
                      ? `${fmtTime(audioCurrent)} / ${fmtTime(audioDuration)}`
                      : fmtTime(audioDuration)}
                  </span>
                </div>
                <p className="truncate text-left text-[10px] opacity-60">
                  <Music2 className="mr-1 inline h-3 w-3" />
                  {audioNames[current.id]}
                </p>
              </div>
            ) : (
              <button
                onClick={() => openFilePicker(current.id)}
                className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/10 px-3 py-1.5 text-xs opacity-70 hover:opacity-100"
              >
                <FolderOpen className="h-3.5 w-3.5" /> โหลดไฟล์เพลงสำหรับรายการนี้
              </button>
            )}
          </div>
        )}
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-xs text-muted-foreground">เวลาสะสม (Accumulated)</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatDuration(totalElapsed)}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-xs text-muted-foreground">รายการถัดไป</p>
          <p className="truncate text-lg font-semibold">
            {next?.title || "— จบโชว์ —"}
          </p>
        </div>
      </div>

      {/* show controls */}
      <div className="rounded-xl border bg-card p-3">
        {/* mode toggle — switchable anytime, even mid-show */}
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
            <Sparkles className="h-4 w-4" /> Run Script (Auto)
          </Button>
        </div>

        {!state.running && state.startedAt == null ? (
          <Button size="xl" className="w-full" onClick={start}>
            <Play className="h-5 w-5" /> START SHOW
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={() => goto(state.currentIndex - 1)}
              disabled={state.mode === "auto" || state.currentIndex === 0}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "ย้อนกลับ"}
            >
              <SkipBack className="h-5 w-5" />
            </Button>
            {/* play/stop — distinct color + label so it isn't mistaken for skip */}
            <Button
              size="lg"
              onClick={pauseToggle}
              className={cn(
                "shrink-0 font-semibold text-white",
                state.running
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-amber-500 hover:bg-amber-600"
              )}
            >
              {state.running ? (
                <>
                  <Pause className="h-5 w-5" /> กำลังเล่น
                </>
              ) : (
                <>
                  <Play className="h-5 w-5" /> เล่นต่อ
                </>
              )}
            </Button>
            <Button
              size="lg"
              className="flex-1"
              onClick={() => goto(state.currentIndex + 1)}
              disabled={state.mode === "auto" || state.currentIndex >= items.length - 1}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "รายการถัดไป"}
            >
              <SkipForward className="h-5 w-5" /> NEXT
            </Button>
            <Button variant="ghost" size="lg" onClick={reset}>
              <RotateCcw className="h-5 w-5" />
            </Button>
          </div>
        )}
        <p className="mt-2 text-center text-xs text-muted-foreground">
          <Radio className="mr-1 inline h-3 w-3" />
          {state.mode === "auto"
            ? "Auto: เปลี่ยนรายการเองเมื่อเพลงจบ — กด Manual เพื่อคุมเอง"
            : "Manual: กด NEXT เพื่อข้ามรายการ — ซิงค์หลายเครื่องอัตโนมัติ"}
        </p>
      </div>

      {/* upcoming list */}
      <div className="rounded-xl border bg-card">
        {items.map((it, i) => {
          const hasFile = !!audioUrls[it.id];
          const isPlayingThis = playingId === it.id && audioPlaying;
          return (
            <div
              key={it.id}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-2 last:border-0",
                i === state.currentIndex && "bg-primary/10"
              )}
            >
              {/* go-to button — locked in Auto mode to prevent accidental jumps */}
              <button
                onClick={() => goto(i)}
                disabled={state.mode === "auto"}
                title={
                  state.mode === "auto"
                    ? "Auto mode — สลับเป็น Manual ก่อนถึงจะเลือกเองได้"
                    : undefined
                }
                className={cn(
                  "flex flex-1 items-center gap-2 text-left text-sm",
                  state.mode === "auto" && "cursor-default"
                )}
              >
                <span className="w-5 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {SETLIST_KIND_SHORT[it.kind as SetlistKind]}
                </Badge>
                <span
                  className={cn(
                    "flex-1 truncate",
                    i === state.currentIndex && "font-medium"
                  )}
                >
                  {it.title || "—"}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatDuration(it.duration_seconds)}
                </span>
              </button>

              {/* audio controls — load file only; playback is via START/NEXT/player */}
              <div className="flex shrink-0 items-center gap-1">
                {/* playing indicator (not a button) */}
                {isPlayingThis && (
                  <Volume2 className="h-3.5 w-3.5 animate-pulse text-primary" />
                )}
                {/* load file */}
                <button
                  onClick={() => openFilePicker(it.id)}
                  title="โหลดไฟล์เพลง"
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted",
                    hasFile
                      ? "text-primary"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
