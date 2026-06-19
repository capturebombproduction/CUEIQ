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
  Volume1,
  VolumeX,
  Hand,
  Sparkles,
  Eye,
  Trash2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { saveAudio, loadAudioForEvent, deleteAudio } from "@/lib/audio-store";
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
  items: initialItems,
}: {
  eventId: string;
  eventName: string;
  items: SetlistItem[];
}) {
  const [state, setState] = useState<LiveState>(INITIAL);
  // The setlist is held in state (seeded from the server prop) so edits made on
  // ANOTHER device — broadcast as "setlist-changed" — can update Live Mode mid-show
  // without a reload. currentIndex is remapped by item id so the show keeps its place.
  const [items, setItems] = useState<SetlistItem[]>(initialItems);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [now, setNow] = useState(() => Date.now());
  const [syncReady, setSyncReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("init"); // raw channel status, for diagnosing sync issues
  // Only ONE device drives the show. This device may control until it receives
  // state from another device (then it becomes a read-only viewer); "ขอควบคุม"
  // flips it back and demotes the others.
  const [isController, setIsController] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // always-current state for use inside stable callbacks (subscribe, visibilitychange)
  const stateRef = useRef(state);
  stateRef.current = state;
  const isControllerRef = useRef(isController);
  isControllerRef.current = isController;
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
  const playingIdRef = useRef(playingId); // for the "ended" listener's stale closure
  playingIdRef.current = playingId;
  // the item whose audio reached its NATURAL end — a viewer must not loop-restart it
  // (the show item can outlast the file via buffer_after). Cleared on the next command.
  const endedItemRef = useRef<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>({}); // itemId → 0–100 (default 100), set per track
  const volumesRef = useRef(volumes); // stable read for the overlap pre-roll effect
  volumesRef.current = volumes;
  const fadeRef = useRef<number | null>(null); // rAF id for the volume fade animation
  // tracks which "currentId→nextId" pair already had auto-trigger fired
  const autoTriggeredForRef = useRef<string | null>(null);
  // tracks which item already triggered an auto-advance (no-audio items)
  const autoAdvanceForRef = useRef<string | null>(null);
  // The item the show has COMMITTED to sound out + when it started (controller clock).
  // Distinct from currentIndex: in Manual you can cue/browse another row while THIS
  // keeps playing. Broadcast so a remote (file-less) controller can still tell the
  // speaker device what should be playing. Updated only on play/commit, not on cue.
  const committedRef = useRef<{ id: string | null; anchor: number | null }>({
    id: null,
    anchor: null,
  });
  // viewer side: the audio intent last received from the controller
  const [remoteAudio, setRemoteAudio] = useState<{
    id: string | null;
    playing: boolean;
    anchor: number | null;
  } | null>(null);

  // ticking clock
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // apply the PLAYING track's own volume to the primary element (per-track)
  useEffect(() => {
    if (!audioRef.current || !playingId) return;
    const v = (volumes[playingId] ?? 100) / 100;
    audioRef.current.volume = Math.min(1, Math.max(0, v));
  }, [volumes, playingId]);

  // restore per-track volume presets for this event (saved on-device, per-device)
  const volumesLoadedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`cueiq:vol:${eventId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setVolumes(parsed);
      }
    } catch {}
    volumesLoadedRef.current = true;
  }, [eventId]);

  // persist volume presets, debounced (the fade buttons update this ~60fps — only
  // the settled value is written). Survives refresh so soundcheck levels stick.
  useEffect(() => {
    if (!volumesLoadedRef.current) return; // don't overwrite before the restore runs
    const id = setTimeout(() => {
      try {
        localStorage.setItem(`cueiq:vol:${eventId}`, JSON.stringify(volumes));
      } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [volumes, eventId]);

  // stop any running fade on unmount
  useEffect(() => {
    return () => {
      if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
    };
  }, []);

  // two audio elements — create once. UI-updating listeners only act for whichever
  // element is currently the primary (audioRef.current).
  useEffect(() => {
    const make = () => {
      const a = new Audio();
      a.addEventListener("ended", () => {
        if (a === audioRef.current) {
          // remember which item finished so the viewer sync won't loop-restart it
          endedItemRef.current = playingIdRef.current;
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
    if (!isControllerRef.current) return; // only the controller drives audio
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
        sec.volume = Math.min(1, Math.max(0, (volumesRef.current[nxt.id] ?? 100) / 100));
        sec.play().catch(() => {});
        overlapNextIdRef.current = nxt.id; // promoted to primary on advance
      }
    }
  }, [now, state, items, audioUrls]);

  // Viewer audio-sync: a NON-controller device that holds the audio file keeps the
  // sound coming out and follows the controller's AUDIO INTENT (which item should be
  // sounding + from where), broadcast separately from the visible currentIndex. That
  // separation is what makes Manual feel right — the controller can cue/browse the
  // next row while THIS device keeps playing the committed track, exactly like a
  // single device, and a file-less remote can still drive the speaker device.
  useEffect(() => {
    if (isControllerRef.current) return; // the controller drives its own audio
    const audio = audioRef.current;
    if (!audio) return;
    const cmd = remoteAudio;
    const url = cmd?.id ? audioUrls[cmd.id] : undefined;

    if (cmd && cmd.id && cmd.playing && url) {
      // this track already played to its natural end — don't loop-restart it (the
      // show item can run past the file via buffer_after); wait for the next command.
      if (endedItemRef.current === cmd.id) {
        if (!audio.paused) audio.pause();
        if (audioPlaying) setAudioPlaying(false);
        return;
      }
      const pos = cmd.anchor != null ? (Date.now() - cmd.anchor) / 1000 : 0;
      if (playingId !== cmd.id) {
        // controller committed a new track we have a file for — switch + seek to it
        audio.src = url;
        audio.currentTime = Math.max(0, pos);
        setPlayingId(cmd.id);
        audio.play().catch(() => {});
        if (!audioPlaying) setAudioPlaying(true);
      } else {
        // same track — resync only if we've drifted from the controller's clock
        if (Math.abs(audio.currentTime - pos) > 0.7) {
          audio.currentTime = Math.max(0, pos);
        }
        if (audio.paused) audio.play().catch(() => {});
        if (!audioPlaying) setAudioPlaying(true);
      }
    } else {
      // controller paused, or we don't have this item's file → stop our audio
      if (!audio.paused) audio.pause();
      if (audioPlaying) setAudioPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteAudio, audioUrls, isController, playingId]);

  // realtime sync
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`live:${eventId}`, {
      config: { broadcast: { self: false } },
    });
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      // Receiving another device's state means someone else is driving → this
      // device steps down to a read-only viewer so it can't fight the controller.
      // We do NOT pause audio here: a device wired to the speakers keeps playing and
      // follows the new controller's commands (see the viewer audio-sync effect).
      if (isControllerRef.current) {
        isControllerRef.current = false;
        setIsController(false);
        audioRef2.current?.pause(); // stop only any overlap pre-roll on the secondary
      }
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
      // audio intent — what should be SOUNDING (skew-corrected anchor). Drives the
      // viewer audio-sync effect; also mirrored into committedRef so this device has
      // a sane "playing track" if it later takes control.
      const anchor =
        typeof payload.audioAnchor === "number"
          ? payload.audioAnchor + skew
          : null;
      const audioId = payload.audioItemId ?? null;
      const audioPlaying = !!payload.audioPlaying;
      // a fresh command from the controller (advance/seek/commit) clears the
      // natural-end guard so the next play isn't blocked.
      endedItemRef.current = null;
      setRemoteAudio({ id: audioId, playing: audioPlaying, anchor });
      if (audioPlaying && audioId) {
        committedRef.current = { id: audioId, anchor };
      }
    });
    // a device that just joined asks for current state; anyone mid-show replies
    ch.on("broadcast", { event: "sync-request" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      const s = stateRef.current;
      if (s.begun) {
        const c = committedRef.current;
        const curId = itemsRef.current[s.currentIndex]?.id ?? null;
        const af = s.running
          ? { audioItemId: curId, audioPlaying: true, audioAnchor: s.itemStartedAt }
          : c.id && c.id !== curId
            ? { audioItemId: c.id, audioPlaying: true, audioAnchor: c.anchor }
            : { audioItemId: c.id ?? curId, audioPlaying: false, audioAnchor: c.anchor };
        ch.send({
          type: "broadcast",
          event: "state",
          payload: {
            ...s,
            sender: meId.current,
            sentAt: Date.now(),
            currentItemId: curId,
            ...af,
          },
        });
      }
    });
    // another device edited the setlist (title/duration/mic/order) → refetch & merge
    ch.on("broadcast", { event: "setlist-changed" }, () => {
      refetchRef.current();
    });
    // controller rode a volume control (Auto Mute / MC / Loudness / slider) → mirror it
    ch.on("broadcast", { event: "volume" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      fadeVolumeForRef.current(payload.itemId, payload.target, payload.ms ?? 0);
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

  // Derive the audio intent for a broadcast: which item should be SOUNDING, whether
  // it's playing, and its start anchor. While running, that's the current item. When
  // not running it's either a Manual cue (a different committed item still plays) or
  // a pause of the current item.
  function audioFields(s: LiveState) {
    const c = committedRef.current;
    const curId = itemsRef.current[s.currentIndex]?.id ?? null;
    if (s.running) {
      return {
        audioItemId: curId,
        audioPlaying: true,
        audioAnchor: s.itemStartedAt,
      };
    }
    if (c.id && c.id !== curId) {
      // Manual: a previously-committed track keeps playing while this row is cued
      return { audioItemId: c.id, audioPlaying: true, audioAnchor: c.anchor };
    }
    // paused (or idle) on the current item
    return { audioItemId: c.id ?? curId, audioPlaying: false, audioAnchor: c.anchor };
  }

  // Build the broadcast payload. currentItemId lets the setlist editor know which
  // row is on air (to lock it), independent of index shifts from concurrent edits.
  function statePayload(s: LiveState) {
    return {
      ...s,
      sender: meId.current,
      sentAt: Date.now(),
      currentItemId: itemsRef.current[s.currentIndex]?.id ?? null,
      ...audioFields(s),
    };
  }

  function apply(next: LiveState, broadcast = true) {
    // Maintain the committed sounding item (for the audio-intent broadcast):
    // running → the current item is what's sounding; reset (not begun) → clear.
    // Every other !running case (Manual cue / pause) deliberately keeps it so the
    // previously-committed track keeps playing while you browse/cue another row.
    if (next.running) {
      committedRef.current = {
        id: itemsRef.current[next.currentIndex]?.id ?? null,
        anchor: next.itemStartedAt,
      };
    } else if (!next.begun) {
      committedRef.current = { id: null, anchor: null };
    }
    setState(next);
    // only the controlling device broadcasts — viewers never push state
    if (broadcast && isControllerRef.current) {
      channelRef.current?.send({
        type: "broadcast",
        event: "state",
        payload: statePayload(next),
      });
    }
  }

  // Pull the latest setlist from the server — fired when another device edits it
  // ("setlist-changed" broadcast). Remap currentIndex by the live item's id so the
  // running show keeps its place and timers (startedAt/itemStartedAt) are untouched.
  async function refetchItems() {
    const supabase = createClient();
    const { data } = await supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true });
    if (!data) return;
    const newItems = data as SetlistItem[];
    const s = stateRef.current;
    const curId = itemsRef.current[s.currentIndex]?.id;
    setItems(newItems);
    if (!curId) return;
    const newIdx = newItems.findIndex((it) => it.id === curId);
    if (newIdx >= 0 && newIdx !== s.currentIndex) {
      setState((prev) => ({ ...prev, currentIndex: newIdx }));
    } else if (newIdx < 0) {
      // the item we were browsing was removed — clamp into range, keep timers
      setState((prev) => ({
        ...prev,
        currentIndex: Math.min(prev.currentIndex, Math.max(0, newItems.length - 1)),
      }));
    }
  }
  // ref so the realtime subscription (registered once) always calls the latest
  const refetchRef = useRef(refetchItems);
  refetchRef.current = refetchItems;

  // Claim control of the show on this device. Broadcasting our current state tells
  // the previous controller to step down (it'll see our message and become a viewer).
  function takeControl() {
    setIsController(true);
    isControllerRef.current = true;
    channelRef.current?.send({
      type: "broadcast",
      event: "state",
      payload: statePayload(stateRef.current),
    });
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

  // Remove a loaded audio file from this device (e.g. wrong file picked). Clears the
  // object URL + IndexedDB copy. Guarded so the track that's on air can't be deleted.
  function removeAudioFile(itemId: string) {
    if (playingId === itemId) return; // never delete the track that's loaded/playing
    const url = audioUrls[itemId];
    if (url) URL.revokeObjectURL(url);
    setAudioUrls((prev) => {
      const n = { ...prev };
      delete n[itemId];
      return n;
    });
    setAudioNames((prev) => {
      const n = { ...prev };
      delete n[itemId];
      return n;
    });
    deleteAudio(eventId, itemId).catch(() => {});
  }

  // Mirror a volume change to the other devices so the controller can ride the
  // speaker device's levels by remote (Auto Mute / MC / Auto Loudness / slider).
  function broadcastVolume(itemId: string, target: number, ms: number) {
    if (!isControllerRef.current) return;
    channelRef.current?.send({
      type: "broadcast",
      event: "volume",
      payload: { sender: meId.current, itemId, target, ms },
    });
  }

  // Fade ONE track's volume to `target` over `ms` (ms<=0 = set instantly). Shared by
  // the local buttons/slider and by the viewer mirroring a remote volume command.
  function fadeVolumeFor(itemId: string, target: number, ms: number) {
    if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
    const start = volumesRef.current[itemId] ?? 100;
    if (ms <= 0 || start === target) {
      setVolumes((prev) => ({ ...prev, [itemId]: target }));
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const v = Math.round(start + (target - start) * p);
      setVolumes((prev) => ({ ...prev, [itemId]: v }));
      fadeRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    fadeRef.current = requestAnimationFrame(step);
  }
  const fadeVolumeForRef = useRef(fadeVolumeFor);
  fadeVolumeForRef.current = fadeVolumeFor;

  // Set one track's volume now (cancels any running fade). Used by the slider.
  function setVolumeFor(itemId: string, to: number) {
    const v = Math.min(100, Math.max(0, Math.round(to)));
    fadeVolumeFor(itemId, v, 0);
    broadcastVolume(itemId, v, 0);
  }

  // Smoothly fade the CURRENT item's volume to `target` over `ms` (default 2s).
  // Auto Mute = 0, MC = 30, Auto Loudness = 100. Mirrors to the speaker device.
  function fadeVolumeTo(target: number, ms = 2000) {
    const cur = items[state.currentIndex];
    if (!cur) return;
    fadeVolumeFor(cur.id, target, ms);
    broadcastVolume(cur.id, target, ms);
  }

  // RUN / pause the show — the deliberate "go live" action. In BOTH modes it
  // plays/pauses the CURRENT item's audio together with the countdown, so pressing
  // "รันโชว์" on a cued item actually fires that track (in Manual it's how you commit
  // a cued song; Auto additionally auto-advances at 0).
  function toggleShowRun() {
    const audio = audioRef.current;
    const cur = items[state.currentIndex];
    if (state.running) {
      // PAUSE — freeze the item countdown (accumulated keeps running via startedAt)
      const frozenItem = state.itemStartedAt
        ? (Date.now() - state.itemStartedAt) / 1000
        : (state.itemElapsedAtPause ?? 0);
      apply({ ...state, running: false, itemElapsedAtPause: frozenItem });
      audio?.pause();
      setAudioPlaying(false);
      if (state.mode === "auto") {
        audioRef2.current?.pause(); // also halt any overlap pre-roll
        overlapNextIdRef.current = null;
        autoTriggeredForRef.current = null; // let overlap re-arm on resume
      }
    } else {
      // RUN — go live with the current item: play its audio + run its countdown
      const offset = state.itemElapsedAtPause ?? 0;
      apply({
        ...state,
        running: true,
        itemStartedAt: Date.now() - offset * 1000,
        itemElapsedAtPause: null,
        startedAt: state.startedAt ?? Date.now(),
      });
      if (cur && audio) {
        const url = audioUrls[cur.id];
        if (playingId === cur.id) {
          // resuming the same (paused) track — continue from where it stopped
          if (url) {
            audio.play().catch(() => {});
            setAudioPlaying(true);
          }
        } else if (url) {
          // committing a newly-cued track that has audio — play from the offset
          audio.src = url;
          audio.currentTime = Math.max(0, offset);
          setPlayingId(cur.id);
          audio.play().catch(() => {});
          setAudioPlaying(true);
        } else {
          // cued item has no audio file (e.g. MC) — stop whatever was still playing
          audio.pause();
          setPlayingId(null);
          setAudioPlaying(false);
        }
      }
    }
  }

  // live scrub (Manual only) — moves the audio head while dragging; the show
  // countdown is re-locked on release so they don't drift.
  function seekAudio(e: React.ChangeEvent<HTMLInputElement>) {
    if (!audioRef.current) return;
    // the scrubber only controls the track actually loaded on the primary element;
    // ignore drags when the current row isn't the playing one (e.g. a cued next item)
    if (playingId !== items[state.currentIndex]?.id) return;
    audioRef.current.currentTime = Number(e.target.value);
  }

  // on release, snap the show countdown to the new audio position and sync viewers
  function commitSeek() {
    const audio = audioRef.current;
    const cur = items[state.currentIndex];
    if (!audio || !cur || playingId !== cur.id) return;
    const pos = audio.currentTime;
    if (state.running) {
      apply({ ...state, itemStartedAt: Date.now() - pos * 1000, itemElapsedAtPause: null });
    } else {
      apply({ ...state, itemStartedAt: null, itemElapsedAtPause: pos });
    }
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
      // Anchor Auto to the track that's ACTUALLY sounding — not wherever the user
      // browsed to in Manual. e.g. song 1 is playing, you peek at song 2's info in
      // Manual, then switch back to Auto → it should resume song 1 (the live track),
      // NOT jump to song 2. The sounding track is playingId locally, or committedRef
      // when we're a file-less remote driving the speaker device (no local playingId).
      const committed = committedRef.current;
      const soundingId = playingId ?? committed.id;
      const soundIdx = soundingId
        ? items.findIndex((it) => it.id === soundingId)
        : -1;
      const haveLocalAudio = !!playingId && !!audio && !audio.paused;
      const idx = soundIdx >= 0 ? soundIdx : state.currentIndex;
      const cur = items[idx];
      // how far into the sounding item we are
      const offset =
        soundIdx >= 0
          ? haveLocalAudio
            ? audio!.currentTime // resume from the live audio position
            : committed.anchor != null
              ? (Date.now() - committed.anchor) / 1000 // remote sounding position
              : 0
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
        } else if (!haveLocalAudio) {
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

    // Returning to the track that is actually SOUNDING — sync the countdown to its
    // REAL position instead of resetting it. The track may be playing locally
    // (playingId) OR on another device we're driving by remote (committedRef): a
    // file-less remote has no playingId, so without the committedRef check, tapping
    // the live track would cue it (running=false) and silence the speaker device.
    const committed = committedRef.current;
    const isSounding = !!it && (it.id === playingId || it.id === committed.id);
    if (state.begun && it && isSounding) {
      const audio = audioRef.current;
      const haveLocalAudio = it.id === playingId && !!audio;
      const pos = haveLocalAudio
        ? audio!.currentTime
        : committed.anchor != null
          ? (Date.now() - committed.anchor) / 1000
          : 0;
      // a locally-held track follows its own paused state; a track sounding on a
      // remote (committed but not held here) is, by definition, still playing.
      const playing = haveLocalAudio ? !audio!.paused : true;
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
    // Only the controller advances (countdown-driven) — it needn't hold the audio
    // files; the device with the files follows via the viewer audio-sync effect.
    if (!isControllerRef.current) return;
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

  if (items.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-10 text-center text-muted-foreground">
        ยังไม่มีรายการในเซ็ตลิสต์ — เพิ่มเพลงก่อนเริ่ม Live Mode
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 landscape:max-w-5xl">
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
        <div className="flex min-w-0 flex-1 items-center gap-2 font-medium">
          <Radio
            className={cn(
              "h-4 w-4 shrink-0",
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
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
              {syncStatus === "init" ? "กำลังเชื่อม…" : syncStatus}
            </span>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground">เวลาจริง</p>
          <p className="font-semibold tabular-nums" suppressHydrationWarning>
            {wallClock}
          </p>
        </div>
      </div>

      {/* current item + next-up prep — stacked in portrait, side by side in
          landscape (e.g. iPad) so the crew can ready the next item's mics/props */}
      <div className="grid gap-4 landscape:grid-cols-2 landscape:items-stretch">
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
            {currentAudioUrl || (isController && state.begun) ? (
              <div className="w-full space-y-1.5 rounded-lg bg-black/10 px-3 py-2">
                {/* scrubber — only when THIS device holds the audio file */}
                {currentAudioUrl && (
                <div className="flex items-center gap-2">
                  {/* status glyph only — play/pause is controlled by the รันโชว์ button */}
                  <span
                    title={state.running ? "กำลังเล่น (คุมที่ปุ่มรันโชว์)" : "หยุดอยู่ (กดรันโชว์เพื่อเล่น)"}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white/80"
                  >
                    {state.running ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
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
                    disabled={state.mode === "auto" || !isController}
                    title={
                      state.mode === "auto"
                        ? "Auto: เลื่อนเวลาเพลงไม่ได้ — คุมที่ปุ่มหยุดโชว์"
                        : !isController
                          ? "ดูอย่างเดียว"
                          : "เลื่อนเวลาเพลง"
                    }
                    className={cn(
                      "h-1.5 flex-1 accent-white",
                      state.mode === "auto" || !isController
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer"
                    )}
                  />
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums opacity-80">
                    {playingId === current.id
                      ? `${fmtTime(audioCurrent)} / ${fmtTime(audioDuration)}`
                      : fmtTime(audioDuration)}
                  </span>
                </div>
                )}

                {/* per-track volume slider — set each track's level (in advance too).
                    View-only devices can see the level but only the controller sets it. */}
                <div className="flex items-center gap-2">
                  <Volume1 className="h-4 w-4 shrink-0 opacity-80" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={volumes[current.id] ?? 100}
                    onChange={(e) => setVolumeFor(current.id, Number(e.target.value))}
                    disabled={!isController}
                    title={
                      isController
                        ? "ความดังของแทร็คนี้ (ตั้งล่วงหน้าได้)"
                        : "ดูอย่างเดียว — คุมความดังที่เครื่องคุม"
                    }
                    className={cn(
                      "h-1.5 flex-1 accent-white",
                      isController
                        ? "cursor-pointer"
                        : "cursor-not-allowed opacity-50"
                    )}
                  />
                  <span className="w-9 shrink-0 text-right text-xs tabular-nums opacity-80">
                    {volumes[current.id] ?? 100}%
                  </span>
                </div>

                {/* big one-tap auto-fade buttons — controller only */}
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => fadeVolumeTo(0, 3000)}
                    disabled={!isController}
                    title="ค่อย ๆ ปิดเสียงเป็น 0% ใน 3 วินาที"
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-rose-600/85 py-3 text-sm font-bold text-white shadow-sm ring-1 ring-rose-400/40 hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-rose-600/85"
                  >
                    <VolumeX className="h-4 w-4" /> Auto Mute
                  </button>
                  <button
                    onClick={() => fadeVolumeTo(30)}
                    disabled={!isController}
                    title="ค่อย ๆ ลดเสียงลงเป็น 30% ใน 2 วินาที (ช่วง MC)"
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-amber-400/90 py-3 text-sm font-bold text-black shadow-sm ring-1 ring-amber-300/50 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-400/90"
                  >
                    <Volume1 className="h-4 w-4" /> MC
                  </button>
                  <button
                    onClick={() => fadeVolumeTo(100, 2500)}
                    disabled={!isController}
                    title="ค่อย ๆ เพิ่มเสียงกลับเป็น 100% ใน 2.5 วินาที"
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600/85 py-3 text-sm font-bold text-white shadow-sm ring-1 ring-emerald-400/40 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-600/85"
                  >
                    <Volume2 className="h-4 w-4" /> Auto Loudness
                  </button>
                </div>

                {currentAudioUrl ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-left text-[10px] opacity-60">
                      <Music2 className="mr-1 inline h-3 w-3" />
                      {audioNames[current.id]}
                    </p>
                    {playingId !== current.id && (
                      <button
                        onClick={() => removeAudioFile(current.id)}
                        title="ลบไฟล์เพลงนี้ออกจากเครื่อง"
                        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] opacity-70 hover:bg-white/15 hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" /> ลบไฟล์
                      </button>
                    )}
                  </div>
                ) : (
                  // controller with no local file: these controls ride the speaker
                  // device's volume by remote
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-left text-[10px] opacity-60">
                      <Volume2 className="mr-1 inline h-3 w-3" /> คุมเสียงของเครื่องที่เล่นไฟล์ (รีโมท)
                    </p>
                    <button
                      onClick={() => openFilePicker(current.id)}
                      title="โหลดไฟล์เพลงลงเครื่องนี้ด้วย"
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] opacity-70 hover:bg-white/15 hover:opacity-100"
                    >
                      <FolderOpen className="h-3 w-3" /> โหลดไฟล์ที่นี่
                    </button>
                  </div>
                )}
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

        {/* NEXT-UP prep card — shown in landscape so the team can ready mics/props
            for what's coming while the current item is still playing */}
        <div className="hidden rounded-2xl border bg-card p-5 text-left shadow-sm landscape:flex landscape:flex-col">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <SkipForward className="h-3.5 w-3.5" /> รายการถัดไป
          </div>
          {next ? (
            <>
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="secondary">
                  {SETLIST_KIND_SHORT[next.kind as SetlistKind]}
                </Badge>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {state.currentIndex + 2} / {items.length}
                </span>
              </div>
              <h3 className="mb-3 break-words text-xl font-bold leading-tight">
                {next.title || "—"}
              </h3>
              {/* time slot — the FULL block (buffers included) + the bare song length */}
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">
                    เวลาเต็ม (รวมบัฟเฟอร์)
                  </p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatDuration(blockSeconds(next))}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">ความยาวเพลง</p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatDuration(next.duration_seconds)}
                  </p>
                </div>
              </div>
              {next.mic_slots?.length > 0 ? (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Radio className="h-3 w-3" /> เตรียมไมค์
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {next.mic_slots.map((s, i) => (
                      <Badge key={i} variant="outline" className="text-sm">
                        {s.mic} → {s.member}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  — ไม่มีไมค์ที่ต้องเตรียม —
                </p>
              )}
              {next.notes && (
                <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  📝 {next.notes}
                </p>
              )}
              {/* pre-set the next track's volume — syncs to the speaker device so the
                  crew can dial the next song's level before it even starts */}
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Volume1 className="h-3 w-3" /> ตั้งความดังล่วงหน้า
                  </p>
                  <span className="text-xs font-semibold tabular-nums">
                    {volumes[next.id] ?? 100}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={volumes[next.id] ?? 100}
                  onChange={(e) => setVolumeFor(next.id, Number(e.target.value))}
                  disabled={!isController}
                  title={
                    isController
                      ? "ตั้งระดับเสียงของเพลงถัดไปล่วงหน้า (ซิงค์ไปเครื่องที่เล่นไฟล์)"
                      : "ดูอย่างเดียว — คุมความดังที่เครื่องคุม"
                  }
                  className={cn(
                    "h-1.5 w-full accent-primary",
                    isController ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                  )}
                />
              </div>
              <p className="mt-auto pt-4 text-xs text-muted-foreground">
                {audioUrls[next.id] ? (
                  <>
                    <Music2 className="mr-1 inline h-3 w-3" /> ไฟล์เพลงพร้อมบนเครื่องนี้
                  </>
                ) : (
                  <>
                    <FolderOpen className="mr-1 inline h-3 w-3" /> ยังไม่ได้โหลดไฟล์เพลง
                  </>
                )}
              </p>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground">
              <p className="text-lg font-semibold">— จบโชว์ —</p>
              <p className="text-sm">ไม่มีรายการถัดไปแล้ว</p>
            </div>
          )}
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 landscape:grid-cols-1">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-xs text-muted-foreground">เวลาสะสม (Accumulated)</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatDuration(totalElapsed)}
          </p>
        </div>
        {/* next-title mini box — redundant with the prep card in landscape, so hide it there */}
        <div className="rounded-xl border bg-card p-4 text-center landscape:hidden">
          <p className="text-xs text-muted-foreground">รายการถัดไป</p>
          <p className="truncate text-lg font-semibold">
            {next?.title || "— จบโชว์ —"}
          </p>
        </div>
      </div>

      {/* show controls */}
      <div className="rounded-xl border bg-card p-3">
        {/* control vs view-only — only one device drives the show */}
        {!isController ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {audioPlaying ? (
                <>
                  <Volume2 className="h-4 w-4 shrink-0" /> เครื่องนี้เล่นเสียงอยู่ —
                  คุมจากเครื่องอื่น
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4 shrink-0" /> ดูอย่างเดียว — ซิงค์จากเครื่องคุม
                </>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={takeControl}
              className="shrink-0 border-amber-400 bg-white"
            >
              ขอควบคุม
            </Button>
          </div>
        ) : (
          state.begun && (
            <p className="mb-2 text-center text-[11px] text-muted-foreground">
              <Radio className="mr-1 inline h-3 w-3" /> เครื่องนี้กำลังคุมโชว์
            </p>
          )
        )}

        {/* mode toggle — switchable anytime, even mid-show */}
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Button
            variant={state.mode === "manual" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("manual")}
            disabled={!isController}
          >
            <Hand className="h-4 w-4" /> Manual
          </Button>
          <Button
            variant={state.mode === "auto" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("auto")}
            disabled={!isController}
          >
            <Sparkles className="h-4 w-4" /> Run Script (Auto)
          </Button>
        </div>

        {!state.begun ? (
          <Button
            size="xl"
            className="w-full"
            onClick={start}
            disabled={!isController}
          >
            <Play className="h-5 w-5" /> START SHOW
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => goto(state.currentIndex - 1)}
              disabled={!isController || state.mode === "auto" || state.currentIndex === 0}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "ย้อนกลับ"}
            >
              <SkipBack className="h-5 w-5" />
            </Button>
            {/* play/stop — distinct color + label so it isn't mistaken for skip */}
            <Button
              size="lg"
              onClick={toggleShowRun}
              disabled={!isController}
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
              disabled={!isController || state.mode === "auto" || state.currentIndex >= items.length - 1}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "รายการถัดไป"}
            >
              <SkipForward className="h-5 w-5 shrink-0" /> NEXT
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={reset}
              disabled={!isController}
            >
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
          // Auto locks navigation; viewers can't navigate either (read-only).
          // In Manual a controller can select any row (current = no-op,
          // playing track = resync, others = cue).
          const locked = state.mode === "auto" || !isController;
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
                  "flex min-w-0 flex-1 items-center gap-2 text-left text-sm",
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
                    "min-w-0 flex-1 truncate",
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
                  title={hasFile ? "เปลี่ยนไฟล์เพลง" : "โหลดไฟล์เพลง"}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted",
                    hasFile
                      ? "text-primary"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
                {/* clear file — only when one is loaded and NOT the playing track */}
                {hasFile && it.id !== playingId && (
                  <button
                    onClick={() => removeAudioFile(it.id)}
                    title="ลบไฟล์เพลงนี้"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
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
