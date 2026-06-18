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
import { saveAudio, loadAudioForEvent } from "@/lib/audio-store";
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
  begun: boolean; // show entered (controls shown) — independent of the run clock
  startedAt: number | null; // when the show FIRST ran — drives accumulated time
  itemStartedAt: number | null;
  itemElapsedAtPause: number | null;
  currentIndex: number;
  mode: ShowMode;
}

const INITIAL: LiveState = {
  running: false,
  begun: false,
  startedAt: null,
  itemStartedAt: null,
  itemElapsedAtPause: null,
  currentIndex: 0,
  mode: "manual",
};

function blockSeconds(it: SetlistItem) {
  // A negative buffer_before is a lead-in for overlapping the PREVIOUS track, not
  // part of this item's own countdown — clamp it to 0 here.
  return (
    Math.max(0, it.buffer_before_seconds || 0) +
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
  const [syncStatus, setSyncStatus] = useState<string>("init"); // raw channel status, for diagnosing sync issues
  const channelRef = useRef<RealtimeChannel | null>(null);
  // always-current state for use inside stable callbacks (subscribe, visibilitychange)
  const stateRef = useRef(state);
  stateRef.current = state;
  const meId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random())
  );

  // audio state — two elements so an incoming track can overlap (negative buffer)
  // without cutting the current one. audioRef = primary (drives the UI scrubber).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioRef2 = useRef<HTMLAudioElement | null>(null);
  const overlapNextIdRef = useRef<string | null>(null); // item pre-rolling on secondary
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

  // two audio elements — create once. UI-updating listeners only act for whichever
  // element is currently the primary (audioRef.current).
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
        if (a === audioRef.current) setAudioCurrent(a.currentTime);
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

  // promote the overlapping secondary element to primary (after a negative-buffer
  // pre-roll) and refresh the scrubber from it.
  function swapAudio() {
    const tmp = audioRef.current;
    audioRef.current = audioRef2.current;
    audioRef2.current = tmp;
    const p = audioRef.current;
    if (p) {
      setAudioCurrent(p.currentTime);
      setAudioDuration(isFinite(p.duration) ? p.duration : 0);
    }
  }

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

  // restore on-device audio files saved for this event (survives refresh)
  useEffect(() => {
    let cancelled = false;
    loadAudioForEvent(eventId)
      .then((saved) => {
        if (cancelled || saved.length === 0) return;
        const urls: Record<string, string> = {};
        const names: Record<string, string> = {};
        for (const s of saved) {
          urls[s.itemId] = URL.createObjectURL(s.blob);
          names[s.itemId] = s.name;
        }
        // a file the user loaded during this async read wins over the restored one
        setAudioUrls((prev) => ({ ...urls, ...prev }));
        setAudioNames((prev) => ({ ...names, ...prev }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eventId]);

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

  // negative buffer (Auto): pre-roll the NEXT track on the secondary element so it
  // overlaps the current one — current keeps playing, next "เล่นสวนขึ้นมา" |lead| sec early.
  useEffect(() => {
    if (state.mode !== "auto" || !state.running || !state.itemStartedAt) return;
    const cur = items[state.currentIndex];
    const nxt = items[state.currentIndex + 1];
    if (!cur || !nxt) return;
    const lead = -(nxt.buffer_before_seconds ?? 0);
    if (lead <= 0) return; // only negative buffer overlaps

    const rem = blockSeconds(cur) - (now - state.itemStartedAt) / 1000;
    const triggerKey = `${cur.id}→${nxt.id}`;
    if (autoTriggeredForRef.current === triggerKey) return;

    if (rem > 0 && rem <= lead) {
      autoTriggeredForRef.current = triggerKey;
      const url = audioUrls[nxt.id];
      const sec = audioRef2.current;
      if (url && sec) {
        sec.pause();
        sec.src = url;
        sec.currentTime = 0;
        sec.play().catch(() => {});
        overlapNextIdRef.current = nxt.id; // promoted to primary on advance
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
      // Correct for clock differences between devices: the sender stamps its own
      // Date.now() as sentAt; we shift its absolute timestamps into OUR clock so
      // both screens count down in step even if their system clocks disagree.
      const skew =
        typeof payload.sentAt === "number" ? Date.now() - payload.sentAt : 0;
      setState({
        running: payload.running,
        begun: payload.begun ?? payload.startedAt != null,
        startedAt: payload.startedAt != null ? payload.startedAt + skew : null,
        itemStartedAt:
          payload.itemStartedAt != null ? payload.itemStartedAt + skew : null,
        itemElapsedAtPause: payload.itemElapsedAtPause ?? null,
        currentIndex: payload.currentIndex,
        mode: payload.mode ?? "manual",
      });
    });
    // a device that just joined asks for current state; anyone mid-show replies
    ch.on("broadcast", { event: "sync-request" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      const s = stateRef.current;
      if (s.begun) {
        ch.send({
          type: "broadcast",
          event: "state",
          payload: { ...s, sender: meId.current, sentAt: Date.now() },
        });
      }
    });
    // set immediately so SDK can queue messages sent before SUBSCRIBED
    channelRef.current = ch;
    ch.subscribe((status, err) => {
      setSyncStatus(status);
      if (err) console.error("[realtime] channel error:", status, err);
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
        payload: { ...next, sender: meId.current, sentAt: Date.now() },
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
    // persist on-device so it survives a refresh (not uploaded anywhere)
    saveAudio(eventId, itemId, file, file.name).catch(() => {});
    e.target.value = "";
  }

  // Preview/check the CURRENT item's audio — pure audio, never touches the
  // show countdown. Use it to listen to a song / verify its settings.
  function togglePreviewAudio() {
    const cur = items[state.currentIndex];
    const audio = audioRef.current;
    if (!cur || !audio) return;
    const url = audioUrls[cur.id];
    if (!url) return;
    if (playingId === cur.id && !audio.paused) {
      audio.pause();
      setAudioPlaying(false);
    } else {
      if (playingId !== cur.id) {
        audio.pause();
        audio.src = url;
        audio.currentTime = 0;
        setPlayingId(cur.id);
      }
      audio.play().catch(() => {});
      setAudioPlaying(true);
    }
  }

  // RUN / pause the show countdown — the deliberate "go live" action.
  // In Manual it controls the timer only (audio is checked separately above).
  // In Auto it also pauses/resumes the playing track so they stay together.
  function toggleShowRun() {
    if (state.running) {
      const frozenItem = state.itemStartedAt
        ? (Date.now() - state.itemStartedAt) / 1000
        : (state.itemElapsedAtPause ?? 0);
      apply({ ...state, running: false, itemElapsedAtPause: frozenItem });
      if (state.mode === "auto") {
        audioRef.current?.pause();
        audioRef2.current?.pause(); // also halt any overlap pre-roll
        overlapNextIdRef.current = null;
        autoTriggeredForRef.current = null; // let overlap re-arm on resume
        setAudioPlaying(false);
      }
    } else {
      const offset = state.itemElapsedAtPause ?? 0;
      apply({
        ...state,
        running: true,
        itemStartedAt: Date.now() - offset * 1000,
        itemElapsedAtPause: null,
        startedAt: state.startedAt ?? Date.now(),
      });
      if (state.mode === "auto") {
        const cur = items[state.currentIndex];
        const url = cur ? audioUrls[cur.id] : undefined;
        const audio = audioRef.current;
        if (url && audio) {
          if (playingId !== cur!.id) {
            audio.src = url;
            audio.currentTime = Math.max(0, offset); // resume from elapsed, not 0
            setPlayingId(cur!.id);
          }
          audio.play().catch(() => {});
          setAudioPlaying(true);
        }
      }
    }
  }

  function seekAudio(e: React.ChangeEvent<HTMLInputElement>) {
    if (!audioRef.current) return;
    // the scrubber only controls the track actually loaded on the primary element;
    // ignore drags when the current row isn't the playing one (e.g. a cued next item)
    if (playingId !== items[state.currentIndex]?.id) return;
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
    if (state.mode === "auto") {
      // Auto: begin running + play first track immediately (run clock starts now)
      apply({ running: true, begun: true, startedAt: ts, itemStartedAt: ts, itemElapsedAtPause: null, currentIndex: 0, mode: "auto" });
      const first = items[0];
      if (first) playItemAudio(first.id);
    } else {
      // Manual: the FIRST song plays + its countdown runs right away (a natural
      // "go"). Accumulated starts now. Subsequent items are manual (cue + play).
      apply({ running: true, begun: true, startedAt: ts, itemStartedAt: ts, itemElapsedAtPause: null, currentIndex: 0, mode: "manual" });
      const first = items[0];
      if (first) playItemAudio(first.id);
    }
  }
  function setMode(mode: ShowMode) {
    // Switching to Auto resumes the script: run the countdown and (re)play the
    // current track synced to the elapsed time, so it continues per script even
    // after a detour into Manual.
    if (mode === "auto" && state.begun) {
      const audio = audioRef.current;
      // Anchor Auto to the track that's ACTUALLY playing — not wherever the user
      // browsed to in Manual. e.g. song 1 is playing, you peek at song 2's info in
      // Manual, then switch back to Auto → it should resume song 1 (the live track),
      // NOT jump to song 2. The real anchor is the currently-playing audio.
      const playIdx = playingId
        ? items.findIndex((it) => it.id === playingId)
        : -1;
      const anchorPlaying = playIdx >= 0 && !!audio && !audio.paused;
      const idx = anchorPlaying ? playIdx : state.currentIndex;
      const cur = items[idx];
      // how far into the current item we are
      const offset = anchorPlaying
        ? audio!.currentTime // resume from the live audio position
        : state.running
          ? state.itemStartedAt
            ? (Date.now() - state.itemStartedAt) / 1000
            : 0
          : (state.itemElapsedAtPause ?? 0);
      apply({
        ...state,
        mode,
        currentIndex: idx,
        running: true,
        itemStartedAt: Date.now() - offset * 1000,
        itemElapsedAtPause: null,
        startedAt: state.startedAt ?? Date.now(),
      });
      const url = cur ? audioUrls[cur.id] : undefined;
      if (cur && url && audio) {
        if (playingId !== cur.id) {
          // a different track is loaded — switch to the anchor track and seek
          audio.src = url;
          audio.currentTime = Math.max(0, offset);
          setPlayingId(cur.id);
        } else if (!anchorPlaying) {
          // same track but it wasn't actively playing — resync its position
          audio.currentTime = Math.max(0, offset);
        }
        // if it's already the live playing track, leave its position untouched
        audio.play().catch(() => {});
        setAudioPlaying(true);
      }
    } else {
      // switching to Manual — stop any pending overlap pre-roll on the secondary
      if (mode === "manual") {
        audioRef2.current?.pause();
        overlapNextIdRef.current = null;
      }
      apply({ ...state, mode });
    }
  }
  function goto(index: number) {
    if (index < 0 || index >= items.length) return;
    if (state.begun && index === state.currentIndex) return; // already current → no-op
    const it = items[index];

    // Returning to the track whose audio is loaded/playing — sync the countdown to
    // its REAL position (audio kept playing while you checked another song) instead
    // of resetting it. e.g. song at 0:30, 5s detour, back → countdown reflects 0:35.
    if (state.begun && it && it.id === playingId) {
      const audio = audioRef.current;
      const pos = audio ? audio.currentTime : 0;
      const playing = !!audio && !audio.paused;
      apply({
        ...state,
        currentIndex: index,
        itemStartedAt: playing ? Date.now() - pos * 1000 : null,
        itemElapsedAtPause: playing ? null : pos,
        running: playing,
      });
      return;
    }
    if (state.mode === "auto") {
      // Overlap hand-off: the next track has been pre-rolling on the secondary
      // element (negative buffer). Promote it instead of restarting from 0.
      if (it && overlapNextIdRef.current === it.id) {
        const lead = -(it.buffer_before_seconds ?? 0);
        swapAudio();
        setPlayingId(it.id);
        setAudioPlaying(true);
        overlapNextIdRef.current = null;
        apply({
          ...state,
          currentIndex: index,
          itemStartedAt: Date.now() - Math.max(0, lead) * 1000, // audio already |lead| in
          itemElapsedAtPause: null,
          running: true,
          startedAt: state.startedAt ?? Date.now(),
        });
        return;
      }
      // Auto: jump + play new track + run countdown
      apply({
        ...state,
        currentIndex: index,
        itemStartedAt: Date.now(),
        itemElapsedAtPause: null,
        running: true,
        startedAt: state.startedAt ?? Date.now(),
      });
      if (it) playItemAudio(it.id);
    } else {
      // Manual: cue the new item FROZEN (countdown waits for รันโชว์). Leave the
      // previous track playing — its row keeps the 🔊 until it ends or is replaced.
      // Don't touch startedAt — accumulated only runs once the show has been run.
      apply({
        ...state,
        currentIndex: index,
        itemStartedAt: null,
        itemElapsedAtPause: 0,
        running: false,
      });
    }
  }
  function reset() {
    audioRef.current?.pause();
    audioRef2.current?.pause();
    overlapNextIdRef.current = null;
    autoTriggeredForRef.current = null;
    autoAdvanceForRef.current = null;
    setPlayingId(null);
    setAudioPlaying(false);
    setAudioCurrent(0);
    setAudioDuration(0);
    apply({ ...INITIAL, mode: state.mode }); // keep chosen mode after reset
  }

  // in Auto mode, advance to the next item when the countdown (duration + buffers)
  // reaches 0 — NOT when the audio file ends. Respects the set buffer time.
  // Only the control device (the one holding audio files) advances; viewers follow via sync.
  useEffect(() => {
    if (state.mode !== "auto" || !state.running) return;
    if (Object.keys(audioUrls).length === 0) return; // viewers don't drive advance
    const cur = items[state.currentIndex];
    if (!cur) return;
    if (state.currentIndex >= items.length - 1) return;
    if (remaining > 0) return;
    if (autoAdvanceForRef.current === cur.id) return;
    autoAdvanceForRef.current = cur.id;
    goto(state.currentIndex + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, state, remaining, audioUrls, items]);

  const wallClock = useMemo(() => nowClock(new Date(now)), [now]);

  const currentAudioUrl = current ? audioUrls[current.id] : undefined;
  const currentAudioPlaying = !!current && playingId === current.id && audioPlaying;

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
            title={syncReady ? "Sync ready" : `สถานะ: ${syncStatus}`}
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              syncReady ? "bg-green-500" : "animate-pulse bg-yellow-400"
            )}
          />
          {!syncReady && (
            <span className="text-[10px] font-normal text-muted-foreground">
              {syncStatus === "init" ? "กำลังเชื่อม…" : syncStatus}
            </span>
          )}
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">เวลาจริง</p>
          <p className="font-semibold tabular-nums" suppressHydrationWarning>
            {wallClock}
          </p>
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
                    onClick={togglePreviewAudio}
                    title="เล่น/หยุดเพลง (เช็คเพลง — ไม่รันโชว์)"
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

        {!state.begun ? (
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
              onClick={toggleShowRun}
              className={cn(
                "shrink-0 font-semibold text-white",
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
          // only Auto locks navigation; in Manual every row is selectable
          // (current = no-op, playing track = resync, others = cue)
          const locked = state.mode === "auto";
          return (
            <div
              key={it.id}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-2 last:border-0",
                i === state.currentIndex && "bg-primary/10"
              )}
            >
              {/* go-to button — locked in Auto and for the current/playing track */}
              <button
                onClick={() => goto(i)}
                disabled={locked}
                title={
                  state.mode === "auto"
                    ? "Auto mode — สลับเป็น Manual ก่อนถึงจะเลือกเองได้"
                    : undefined
                }
                className={cn(
                  "flex flex-1 items-center gap-2 text-left text-sm",
                  locked && "cursor-default"
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

      <p className="px-1 text-center text-[11px] text-muted-foreground">
        <FolderOpen className="mr-1 inline h-3 w-3" />
        ไฟล์เพลงเก็บไว้ในเครื่องนี้ (ไม่ได้อัปโหลด) — เปิดใหม่/รีเฟรชแล้วยังอยู่
      </p>
    </div>
  );
}
