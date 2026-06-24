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
  Loader2,
  CloudUpload,
  Repeat,
  ChevronUp,
  ChevronDown,
  Flag,
  Timer,
  GripVertical,
  CheckCircle2,
  HardDriveDownload,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { saveAudio, loadAudioForEvent } from "@/lib/audio-store";
import { getCachedSongBlob } from "@/lib/song-cache";
import { persistLastRun } from "@/lib/show-run-outbox";
import {
  buildSongAudioPath,
  uploadEventAudio,
  downloadEventAudio,
  removeEventAudio,
} from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LiveStatusStrip } from "@/components/event/live-status-strip";
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

type SongAudioMap = Record<string, { path: string | null; name: string | null }>;

// Resolve a setlist item's EFFECTIVE audio: a library-linked item (song_id) plays
// its SONG's file; an unlinked legacy item keeps its own audio_path. Normalizing
// here lets the rest of Live Mode keep reading it.audio_path / it.audio_name as-is.
function resolveItemAudio(it: SetlistItem, songAudio: SongAudioMap): SetlistItem {
  if (!it.song_id) return it;
  const sa = songAudio[it.song_id];
  return { ...it, audio_path: sa?.path ?? null, audio_name: sa?.name ?? null };
}

export function LiveMode({
  eventId,
  groupId,
  eventName,
  items: initialItems,
  songAudio,
  canEdit,
  lastRunSeconds,
  lastRunAt,
}: {
  eventId: string;
  groupId: string;
  eventName: string;
  items: SetlistItem[];
  songAudio: SongAudioMap;
  /** Admin-only: in-show editing (reorder / file change / loop) + saving the
   * "จบโชว์" record. Members/Ar may rehearse playback but never edit live. */
  canEdit: boolean;
  lastRunSeconds: number | null;
  lastRunAt: string | null;
}) {
  const [state, setState] = useState<LiveState>(INITIAL);
  // The setlist is held in state (seeded from the server prop) so edits made on
  // ANOTHER device — broadcast as "setlist-changed" — can update Live Mode mid-show
  // without a reload. currentIndex is remapped by item id so the show keeps its place.
  const [items, setItems] = useState<SetlistItem[]>(() =>
    initialItems.map((it) => resolveItemAudio(it, songAudio))
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // song_id → audio (seeded from the bundle; refreshed on setlist-changed). The
  // resolver reads this so library-linked items play the library song's file.
  const songAudioRef = useRef<SongAudioMap>(songAudio);
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
  // "เวลาโชว์ล่าสุด" — accumulated time saved by จบโชว์. Stored on the EVENT (DB) so
  // it's permanent + shows on every device + the dashboard; kept apart from the live
  // state so a normal Reset Show doesn't erase it; cleared by its own ล้าง button.
  const [lastRun, setLastRun] = useState<{ seconds: number; at: number } | null>(() =>
    lastRunSeconds != null
      ? { seconds: lastRunSeconds, at: lastRunAt ? new Date(lastRunAt).getTime() : Date.now() }
      : null
  );
  const [audioNames, setAudioNames] = useState<Record<string, string>>({}); // itemId → filename
  // online sync: which Storage path this device currently holds locally (per item),
  // and which items are busy uploading/downloading (for the UI spinner).
  const cachedPathRef = useRef<Record<string, string | null>>({});
  const [audioBusy, setAudioBusy] = useState<Record<string, "up" | "down">>({});
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
  // Per-DEVICE sound output (local, NOT broadcast): is this device the one that
  // actually makes sound (e.g. plugged into the PA)? A remote/control device sets
  // this OFF so it stays silent without muting the PA device. Default ON.
  const [soundOutput, setSoundOutput] = useState(true);
  const volumesRef = useRef(volumes); // stable read for the overlap pre-roll effect
  volumesRef.current = volumes;
  const fadeRef = useRef<number | null>(null); // rAF id for the volume fade animation
  // throttle state for volume broadcasts (slider drag would otherwise flood the channel)
  const volBcastRef = useRef<{
    last: number;
    timer: ReturnType<typeof setTimeout> | null;
    pending: { itemId: string; target: number; ms: number } | null;
  }>({ last: 0, timer: null, pending: null });
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

  // ticking clock — 500ms is plenty for a whole-second countdown and halves the
  // re-render rate of this (large) component vs 250ms.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
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

  // Crash/reload recovery: restore a recently-running show so an accidental refresh
  // (or a browser crash) doesn't reset the live position + accumulated time. The
  // timestamps are absolute, so the clock resumes as if nothing happened; a live
  // controller on another device still overrides this via the realtime sync.
  const liveRestoredRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`cueiq:live:${eventId}`);
      if (raw) {
        const snap = JSON.parse(raw);
        const fresh =
          typeof snap?.savedAt === "number" &&
          Date.now() - snap.savedAt < 6 * 60 * 60 * 1000; // within 6h
        if (snap?.state?.begun && fresh) {
          committedRef.current = snap.committed ?? { id: null, anchor: null };
          setState(snap.state as LiveState);
          toast.message("กู้คืนสถานะโชว์ที่ค้างไว้", {
            description: "เวลาเดินต่อจากเดิม — กดรีเซ็ตถ้าจะเริ่มใหม่",
          });
        }
      }
    } catch {}
    liveRestoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // persist the running show (debounced); a reset (begun=false) clears it
  useEffect(() => {
    if (!liveRestoredRef.current) return; // don't write before the restore check ran
    const id = setTimeout(() => {
      try {
        if (state.begun) {
          localStorage.setItem(
            `cueiq:live:${eventId}`,
            JSON.stringify({
              state,
              committed: committedRef.current,
              savedAt: Date.now(),
            })
          );
        } else {
          localStorage.removeItem(`cueiq:live:${eventId}`);
        }
      } catch {}
    }, 500);
    return () => clearTimeout(id);
  }, [state, eventId]);

  // stop any running fade / pending volume broadcast on unmount
  useEffect(() => {
    const vb = volBcastRef.current; // stable object (never reassigned, only mutated)
    return () => {
      if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
      if (vb.timer) clearTimeout(vb.timer);
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
        if (a !== audioRef.current) return;
        setAudioCurrent(a.currentTime);
        // SINGLE AUDIO SOURCE: the sounding device OWNS its playback position. We
        // never nudge playbackRate or seek to chase a remote clock — that continuous
        // convergence was the source of audible mid-show jumps. Always natural 1x.
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

  // Load this device's sound-output preference once (per-device, survives reload).
  useEffect(() => {
    try {
      if (localStorage.getItem("cueiq:soundOutput") === "0") setSoundOutput(false);
    } catch {
      /* ignore */
    }
  }, []);

  // Apply sound-output to BOTH elements (muted is a persistent element property, so
  // this covers every src change / play / overlap) + persist the choice. When OFF
  // the device still runs the whole show + countdown, just silently.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = !soundOutput;
    if (audioRef2.current) audioRef2.current.muted = !soundOutput;
    try {
      localStorage.setItem("cueiq:soundOutput", soundOutput ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [soundOutput]);

  // Lock the SOUND device into Live Mode while a show is live: leaving would cut the
  // audio. Block in-app navigation (back / header nav / logo) + warn on refresh/close.
  // To leave, turn off "เสียงออกเครื่องนี้" first (then edit on a remote with sound off).
  useEffect(() => {
    if (!(soundOutput && state.begun)) return;
    const livePath = `/events/${eventId}/live`;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && !(a.getAttribute("href") ?? "").includes(livePath)) {
        e.preventDefault();
        e.stopPropagation();
        toast.warning("ปิด “เสียงออกเครื่องนี้” ก่อนถึงจะออกจาก Live Mode ได้", {
          description: "กันเสียงดับกลางโชว์ — แก้ละเอียดให้ใช้อีกเครื่อง (รีโมท ปิดเสียง)",
        });
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [soundOutput, state.begun, eventId]);

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

  // restore the local IndexedDB cache for this event (instant, survives refresh).
  // The download effect below then fills in anything this device hasn't cached yet
  // from Storage (e.g. a file another device uploaded).
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
          cachedPathRef.current[s.itemId] = s.path; // remember which online version we hold
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

  // Download any online audio this device doesn't already hold (or holds a stale
  // version of). Runs whenever the setlist changes — so a file uploaded on another
  // device appears here after the "setlist-changed" refetch. Best-effort: a failure
  // just leaves whatever local copy exists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const it of items) {
        const path = it.audio_path;
        if (!path) continue;
        // LOCK the on-air file: never re-download or revoke the track that's
        // currently sounding (a mid-show library re-upload won't cut the live song).
        if (it.id === playingIdRef.current && audioUrlsRef.current[it.id]) continue;
        // already holding this exact version locally? skip.
        if (cachedPathRef.current[it.id] === path && audioUrlsRef.current[it.id]) continue;
        setAudioBusy((prev) => ({ ...prev, [it.id]: "down" }));
        try {
          // Fast path: if the band-library prefetch already cached this file
          // on this device, use it instead of hitting the network.
          const blob = (await getCachedSongBlob(path)) ?? (await downloadEventAudio(path));
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          if (audioUrlsRef.current[it.id]) URL.revokeObjectURL(audioUrlsRef.current[it.id]);
          const name = it.audio_name ?? "เพลง";
          setAudioUrls((prev) => ({ ...prev, [it.id]: url }));
          setAudioNames((prev) => ({ ...prev, [it.id]: name }));
          cachedPathRef.current[it.id] = path;
          saveAudio(eventId, it.id, blob, name, path).catch(() => {});
        } catch {
          /* keep any existing local copy */
        } finally {
          if (!cancelled)
            setAudioBusy((prev) => {
              const n = { ...prev };
              delete n[it.id];
              return n;
            });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, eventId]);

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

  // Viewer audio follow (SINGLE AUDIO SOURCE model): a non-controller speaker device
  // follows the controller's DISCRETE intent only — which item should sound, and
  // play/pause. It does NOT import the controller's position: after loading a newly
  // committed track (a one-time start offset), it plays from its OWN clock. This is
  // what removes every involuntary mid-show seek (drift / hand-off / reconnect jump):
  // nothing outside this device can move its playhead except a deliberate song change.
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
      if (playingId !== cmd.id) {
        // DISCRETE track change committed by the controller (user-intended) — the
        // ONLY position we ever import: load + seek to the start offset ONCE, then
        // this device owns the position from here on.
        const pos = cmd.anchor != null ? (Date.now() - cmd.anchor) / 1000 : 0;
        audio.src = url;
        audio.currentTime = Math.max(0, pos);
        audio.playbackRate = 1;
        setPlayingId(cmd.id);
        audio.play().catch(() => {});
        if (!audioPlaying) setAudioPlaying(true);
      } else {
        // same track already loaded — follow PLAY only; NEVER touch the position.
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
      const fromController = !!payload.fromController;
      // A viewer's sync-reply (fromController=false) is only useful to a device that
      // hasn't picked up the show yet — never let it overwrite or demote an active
      // session. This is what keeps the controller in control after a reconnect:
      // its own sync-request gets viewer replies, which we now ignore.
      if (!fromController && stateRef.current.begun) return;
      // An ACTIVE controller is driving → step down to a read-only viewer so we can't
      // fight it. (We do NOT pause audio: a speaker-wired device keeps playing and
      // follows the new controller's commands — see the viewer audio-sync effect.)
      if (fromController && isControllerRef.current) {
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
        const curId = itemsRef.current[s.currentIndex]?.id ?? null;
        // same audio-intent logic as a normal broadcast — incl. the real-position
        // anchor when this device is the one sounding the track (see audioFields).
        const af = audioFields(s);
        ch.send({
          type: "broadcast",
          event: "state",
          payload: {
            ...s,
            sender: meId.current,
            sentAt: Date.now(),
            fromController: isControllerRef.current,
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
    // another device saved/cleared the "last show time" → mirror it live
    ch.on("broadcast", { event: "lastrun" }, ({ payload }) => {
      setLastRun(payload?.record ?? null);
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
    // REAL-TIME library audio: a group-scoped channel the library broadcasts on
    // when a song's audio is uploaded / replaced / deleted → re-resolve + download
    // live across devices, no reload. (broadcast, not postgres_changes — RLS
    // postgres changes don't deliver with the publishable key.) The on-air track
    // is locked by the download effect, so a mid-show change can't cut the live song.
    const songCh = supabase.channel(`songs:${groupId}`);
    songCh.on("broadcast", { event: "changed" }, () => refetchRef.current());
    songCh.subscribe();

    return () => {
      channelRef.current = null;
      setSyncReady(false);
      supabase.removeChannel(ch);
      supabase.removeChannel(songCh);
    };
  }, [eventId, groupId]);

  // Derive the audio intent for a broadcast: which item should be SOUNDING, whether
  // it's playing, and its start anchor. While running, that's the current item. When
  // not running it's either a Manual cue (a different committed item still plays) or
  // a pause of the current item.
  function audioFields(s: LiveState) {
    const c = committedRef.current;
    const curId = itemsRef.current[s.currentIndex]?.id ?? null;
    if (s.running) {
      // Anchor to the REAL <audio> position when THIS device is the one actually
      // sounding the track locally. The <audio> clock drifts from wall-clock over a
      // long track and the controller never self-corrects (it stays at 1x), so
      // broadcasting itemStartedAt (pure wall-clock) makes other devices — and
      // especially a NEW controller right after take-control — re-assert a stale
      // anchor that hard-seeks the speaker device ("กระโดดแวบ" on hand-off). Fall back
      // to the wall-clock anchor when we don't hold the file (a file-less remote
      // controller): by then the committed anchor already tracks the real position.
      const a = audioRef.current;
      const anchor =
        a && playingIdRef.current === curId && !a.paused
          ? Date.now() - a.currentTime * 1000
          : s.itemStartedAt;
      return {
        audioItemId: curId,
        audioPlaying: true,
        audioAnchor: anchor,
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
      // whether THIS device is the active controller — receivers only step down for
      // a real controller, never for a viewer's sync-reply (survives reconnects).
      fromController: isControllerRef.current,
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
    // refresh songs too, so a library file uploaded on another device resolves
    const [itemsRes, songsRes] = await Promise.all([
      supabase
        .from("setlist_items")
        .select("*")
        .eq("event_id", eventId)
        .order("sort_order", { ascending: true }),
      supabase.from("songs").select("id, audio_path, audio_name").eq("group_id", groupId),
    ]);
    if (!itemsRes.data) return;
    if (songsRes.data) {
      const map: SongAudioMap = {};
      for (const s of songsRes.data as {
        id: string;
        audio_path: string | null;
        audio_name: string | null;
      }[]) {
        map[s.id] = { path: s.audio_path, name: s.audio_name };
      }
      songAudioRef.current = map;
    }
    const newItems = (itemsRes.data as SetlistItem[]).map((it) =>
      resolveItemAudio(it, songAudioRef.current)
    );
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

  // Auto pick-up library audio: when this tab regains focus (e.g. you just
  // uploaded a file in the library on another tab), re-fetch songs + setlist so
  // linked items get their audio without a manual reload. The on-air file is
  // locked by the download effect, so the live track is never cut.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") refetchRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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
    // Default is sound ON, so a remote that takes control would suddenly also blare
    // the BGM. Remind them to mute this device if it's only meant to drive the show.
    if (soundOutput) {
      toast("เครื่องนี้กำลังคุมโชว์ + เปิดเสียงอยู่", {
        description: "ถ้าจะใช้เป็นรีโมท (ไม่ออกเสียง) แตะเพื่อปิดเสียงเครื่องนี้",
        action: { label: "ปิดเสียงเครื่องนี้", onClick: () => setSoundOutput(false) },
        duration: 8000,
      });
    }
  }

  // audio controls
  function openFilePicker(itemId: string) {
    if (!canEdit) return;
    loadTargetRef.current = itemId;
    fileInputRef.current?.click();
  }

  function bcastSetlistChanged() {
    channelRef.current?.send({
      type: "broadcast",
      event: "setlist-changed",
      payload: { sender: meId.current },
    });
  }

  // Toggle "loop the BGM" for an item (Manual only — must be set before Auto runs).
  // The audio loops to fill the item's time and Live Mode fades it out to end on
  // time. Persists + syncs like any setlist edit.
  async function toggleLoop(itemId: string) {
    if (!canEdit) return;
    const item = itemsRef.current.find((it) => it.id === itemId);
    if (!item) return;
    const next = !item.loop_audio;
    setItems((prev) =>
      prev.map((it) => (it.id === itemId ? { ...it, loop_audio: next } : it))
    );
    const supabase = createClient();
    await supabase.from("setlist_items").update({ loop_audio: next }).eq("id", itemId);
    bcastSetlistChanged();
  }

  // Quick-reorder a row in Live Mode (Manual + controller only): swap sort_order
  // with the neighbour, keep currentIndex on the same item, persist + broadcast so
  // every device re-syncs. Detailed edits (time/mic/buffers) stay in the editor.
  async function moveItem(index: number, dir: -1 | 1) {
    if (!canEdit) return;
    const arr = itemsRef.current;
    const j = index + dir;
    if (j < 0 || j >= arr.length) return;
    const a = arr[index];
    const b = arr[j];
    const curId = arr[stateRef.current.currentIndex]?.id;
    const reordered = arr
      .map((it) =>
        it.id === a.id
          ? { ...it, sort_order: b.sort_order }
          : it.id === b.id
            ? { ...it, sort_order: a.sort_order }
            : it
      )
      .sort((x, y) => x.sort_order - y.sort_order);
    setItems(reordered);
    if (curId) {
      const newIdx = reordered.findIndex((it) => it.id === curId);
      if (newIdx >= 0 && newIdx !== stateRef.current.currentIndex) {
        setState((prev) => ({ ...prev, currentIndex: newIdx }));
      }
    }
    const supabase = createClient();
    await Promise.all([
      supabase.from("setlist_items").update({ sort_order: b.sort_order }).eq("id", a.id),
      supabase.from("setlist_items").update({ sort_order: a.sort_order }).eq("id", b.id),
    ]);
    bcastSetlistChanged();
  }

  // "จบโชว์" — freeze the accumulated clock + SAVE it as the last-show record (kept
  // apart from the live state so a normal Reset Show doesn't erase it). Not a real
  // end: the show just pauses; Reset Show later clears it for the next run.
  function endShow() {
    if (!canEdit) return;
    const s = stateRef.current;
    const seconds = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
    const at = Date.now();
    const rec = { seconds, at };
    setLastRun(rec);
    // persist on the event (permanent + cross-device) + live-update other devices.
    // Queued for replay if this device is offline (a fully-offline show still lands
    // its run time on the server when it reconnects — see show-run-outbox).
    persistLastRun(eventId, seconds, at).catch(() => {});
    channelRef.current?.send({
      type: "broadcast",
      event: "lastrun",
      payload: { record: rec },
    });
    // pause so the accumulated clock stops (does NOT reset the show)
    if (s.running) {
      const frozenItem = s.itemStartedAt
        ? (Date.now() - s.itemStartedAt) / 1000
        : (s.itemElapsedAtPause ?? 0);
      apply({ ...s, running: false, itemElapsedAtPause: frozenItem });
      audioRef.current?.pause();
      audioRef2.current?.pause();
      setAudioPlaying(false);
    }
    toast.success(`บันทึกเวลาโชว์ล่าสุด ${formatDuration(seconds)} แล้ว`);
  }

  function clearLastRun() {
    if (!canEdit) return;
    setLastRun(null);
    persistLastRun(eventId, null, null).catch(() => {});
    channelRef.current?.send({
      type: "broadcast",
      event: "lastrun",
      payload: { record: null },
    });
  }

  // Drag-drop reorder (desktop; touch uses the ▲▼ buttons since native HTML5 DnD
  // doesn't fire on touch). Move an item from one index to another, renumber, persist
  // the changed rows, keep currentIndex on the same item, broadcast.
  const dragIndexRef = useRef<number | null>(null);
  async function reorderTo(from: number, to: number) {
    if (!canEdit) return;
    if (from === to) return;
    const orig = itemsRef.current;
    const arr = [...orig];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const renumbered = arr.map((it, i) => ({ ...it, sort_order: i + 1 }));
    const curId = orig[stateRef.current.currentIndex]?.id;
    setItems(renumbered);
    if (curId) {
      const newIdx = renumbered.findIndex((it) => it.id === curId);
      if (newIdx >= 0 && newIdx !== stateRef.current.currentIndex) {
        setState((p) => ({ ...p, currentIndex: newIdx }));
      }
    }
    const supabase = createClient();
    await Promise.all(
      renumbered
        .filter((it) => orig.find((o) => o.id === it.id)?.sort_order !== it.sort_order)
        .map((it) =>
          supabase.from("setlist_items").update({ sort_order: it.sort_order }).eq("id", it.id)
        )
    );
    bcastSetlistChanged();
  }

  // Pick a file in Live Mode = the QUICK/ad-hoc path (you forgot to prep in the
  // library). Plays instantly on this device, then uploads to R2 as a TEMPORARY
  // library song (auto-cleans after 3 days) and LINKS this item to it — so all
  // audio lives in the library, every device can play it, and you can promote it
  // to permanent in the library. (Deleting/managing audio is done in the library,
  // not here.) R2 has no per-file size cap, so full WAV masters upload as-is.
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const itemId = loadTargetRef.current;
    e.target.value = "";
    if (!canEdit) return;
    if (!file || !itemId) return;
    const item = itemsRef.current.find((it) => it.id === itemId);
    if (!item) return;

    // instant local playback
    if (audioUrls[itemId]) URL.revokeObjectURL(audioUrls[itemId]);
    const url = URL.createObjectURL(file);
    setAudioUrls((prev) => ({ ...prev, [itemId]: url }));
    setAudioNames((prev) => ({ ...prev, [itemId]: file.name }));

    setAudioBusy((prev) => ({ ...prev, [itemId]: "up" }));
    try {
      const supabase = createClient();
      const legacyPath = item.song_id ? null : item.audio_path ?? null; // pre-library file to clean up
      // create a TEMPORARY library song (auto-clean in 3 days) + link the item
      const expires = new Date(Date.now() + 3 * 86400000).toISOString();
      const { data: song, error: songErr } = await supabase
        .from("songs")
        .insert({
          tenant_id: item.tenant_id,
          group_id: groupId,
          title: item.title || file.name,
          duration_seconds: item.duration_seconds,
          audio_expires_at: expires,
          copyright_status: "pending",
        })
        .select("id")
        .single();
      if (songErr || !song) throw songErr ?? new Error("สร้างเพลงในคลังไม่สำเร็จ");
      const songId = (song as { id: string }).id;
      const path = buildSongAudioPath(item.tenant_id, groupId, songId, file.name);
      await uploadEventAudio(path, file, file.type);
      await supabase
        .from("songs")
        .update({ audio_path: path, audio_name: file.name })
        .eq("id", songId);
      const { error: linkErr } = await supabase
        .from("setlist_items")
        .update({ song_id: songId })
        .eq("id", itemId);
      if (linkErr) throw linkErr;
      songAudioRef.current[songId] = { path, name: file.name };
      cachedPathRef.current[itemId] = path;
      setItems((prev) =>
        prev.map((it) =>
          it.id === itemId
            ? { ...it, song_id: songId, audio_path: path, audio_name: file.name }
            : it
        )
      );
      saveAudio(eventId, itemId, file, file.name, path).catch(() => {});
      if (legacyPath) removeEventAudio(legacyPath).catch(() => {});
      bcastSetlistChanged();
      toast.success("อัปขึ้นคลังเป็นเพลงชั่วคราว (3 วัน) — เก็บถาวรได้ในคลังเพลง");
    } catch (err) {
      // online upload failed — still keep a local-only copy so THIS device can play
      saveAudio(eventId, itemId, file, file.name).catch(() => {});
      toast.error("อัปโหลดออนไลน์ไม่สำเร็จ — ไฟล์ยังเล่นได้เฉพาะเครื่องนี้", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAudioBusy((prev) => {
        const n = { ...prev };
        delete n[itemId];
        return n;
      });
    }
  }

  // Mirror a volume change to the other devices so the controller can ride the
  // speaker device's levels by remote (Auto Mute / MC / Auto Loudness / slider).
  // The slider's onChange fires on every drag pixel, so coalesce to ~8/sec with a
  // trailing send (the final value always lands) — a raw send per pixel would flood
  // the channel. Single calls (the fade buttons) go out immediately.
  function broadcastVolume(itemId: string, target: number, ms: number) {
    if (!isControllerRef.current) return;
    const send = (p: { itemId: string; target: number; ms: number }) =>
      channelRef.current?.send({
        type: "broadcast",
        event: "volume",
        payload: { sender: meId.current, ...p },
      });
    const r = volBcastRef.current;
    const now = performance.now();
    const GAP = 120;
    if (now - r.last >= GAP) {
      r.last = now;
      send({ itemId, target, ms });
    } else {
      r.pending = { itemId, target, ms };
      if (!r.timer) {
        r.timer = setTimeout(() => {
          r.timer = null;
          r.last = performance.now();
          if (r.pending) send(r.pending);
          r.pending = null;
        }, GAP - (now - r.last));
      }
    }
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
    let lastSet = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const v = Math.round(start + (target - start) * p);
      // drive the audio smoothly EVERY frame (imperative — no React re-render)
      if (playingIdRef.current === itemId && audioRef.current) {
        audioRef.current.volume = Math.min(1, Math.max(0, v / 100));
      }
      // refresh the on-screen slider ~12x/sec (and at the end) instead of ~60x/sec,
      // so a 2–3s fade doesn't re-render this whole component on every frame
      if (p >= 1 || t - lastSet >= 80) {
        lastSet = t;
        setVolumes((prev) => ({ ...prev, [itemId]: v }));
      }
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

  // Running + this device holds the sounding track's file, but audio isn't playing —
  // e.g. after a reload (browsers block autoplay without a user gesture). Offer a tap.
  const soundingId = committedRef.current.id ?? current?.id ?? null;
  const needsAudioResume =
    state.running && !audioPlaying && !!soundingId && !!audioUrls[soundingId];

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

  // Resume audio after a reload / autoplay-block: load the sounding track and seek to
  // the current position. The user's tap supplies the gesture browsers require to play.
  function resumeAudio() {
    const audio = audioRef.current;
    const sid = committedRef.current.id ?? items[state.currentIndex]?.id ?? null;
    const url = sid ? audioUrls[sid] : undefined;
    if (!audio || !sid || !url) return;
    const anchor = committedRef.current.anchor ?? state.itemStartedAt;
    const pos = anchor ? (Date.now() - anchor) / 1000 : 0;
    if (playingId !== sid) audio.src = url;
    audio.currentTime = Math.max(0, pos);
    setPlayingId(sid);
    audio
      .play()
      .then(() => setAudioPlaying(true))
      .catch(() => {});
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
      // Anchor Auto to the track that's ACTUALLY SOUNDING — not wherever the user
      // merely cued/browsed in Manual. e.g. song 3 is playing, you tap song 5 to
      // peek/cue it (song 3 keeps playing), then switch back to Auto → it must resume
      // song 3 and continue the playlist, NOT jump to the cued song 5. To deliberately
      // skip ahead, PLAY the target in Manual first (รันโชว์) — that makes it the
      // sounding track, so Auto then continues from there. The sounding track is
      // playingId locally, or committedRef when we're a file-less remote driving the
      // speaker device (no local playingId).
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
    // A running show shouldn't be wiped by an accidental tap on the ↺ button —
    // confirm first (pre-show reset is harmless, so skip the prompt then).
    if (
      state.begun &&
      !window.confirm(
        "รีเซ็ตโชว์? ตำแหน่งและเวลาจะเริ่มใหม่ทั้งหมด\n(ถ้าต้องการเก็บเวลาโชว์ ให้กด “จบโชว์” ก่อน)"
      )
    ) {
      return;
    }
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

  // Keep the primary element's native loop flag in sync with the sounding item, so
  // a "loop" item's BGM replays seamlessly to fill its time.
  useEffect(() => {
    const playing = items.find((it) => it.id === playingId);
    if (audioRef.current) audioRef.current.loop = !!playing?.loop_audio;
  }, [playingId, items]);

  // Loop items: fade the BGM out over the last 3s (= Auto Mute) so it ends right on
  // the item's set time, then the normal countdown advances/stops it. Restore the
  // item's volume once we've moved off it, so a re-cue isn't silent.
  const loopFadeRef = useRef<{ id: string; prevVol: number } | null>(null);
  useEffect(() => {
    const cur = items[state.currentIndex];
    const sounding = !!cur && cur.id === playingId; // current item is the one playing
    if (
      cur &&
      cur.loop_audio &&
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
    // moved off the faded item OR paused mid-fade → restore its volume so it isn't
    // left stuck silent on a re-cue / resume (then the fade re-arms if still near end).
    if (
      loopFadeRef.current &&
      (loopFadeRef.current.id !== playingId || !state.running)
    ) {
      const { id, prevVol } = loopFadeRef.current;
      loopFadeRef.current = null;
      setVolumeFor(id, prevVol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, remaining, playingId, state.running, audioPlaying]);

  // Operator keyboard shortcuts (controller only): Space = START / run-pause,
  // →/N = next, ← = previous. Ignored while typing in a field. Re-assigned every
  // render so it sees fresh state; calls the SAME guarded handlers as the buttons,
  // so Auto-mode locks and bounds still apply.
  const keyActionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyActionRef.current = (e: KeyboardEvent) => {
    if (!isControllerRef.current) return;
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
    const onKey = (e: KeyboardEvent) => keyActionRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const wallClock = useMemo(() => nowClock(new Date(now)), [now]);

  const currentAudioUrl = current ? audioUrls[current.id] : undefined;
  const currentBusy = current ? audioBusy[current.id] : undefined;
  const currentHasOnline = current ? !!current.audio_path : false;

  // The upcoming list doesn't depend on the clock or the audio scrubber position, so
  // memoize it — otherwise every 500ms tick and every audio timeupdate would re-render
  // all N rows. Recompute only when the setlist or the playback selection changes.
  // (Handlers read state/playingId/items/audioUrls — all in the dep list.)
  const upcomingRows = useMemo(
    () =>
      items.map((it, i) => {
        const hasLocal = !!audioUrls[it.id];
        const hasFile = hasLocal || !!it.audio_path; // online file counts even if not downloaded yet
        const busy = audioBusy[it.id];
        const isPlayingThis = playingId === it.id && audioPlaying;
        const locked = state.mode === "auto" || !isController;
        return (
          <div
            key={it.id}
            onDragOver={(e) => {
              if (!locked && dragIndexRef.current !== null) e.preventDefault();
            }}
            onDrop={() => {
              if (!locked && dragIndexRef.current !== null && dragIndexRef.current !== i) {
                reorderTo(dragIndexRef.current, i);
              }
              dragIndexRef.current = null;
            }}
            className={cn(
              "flex w-full items-center gap-2 border-b px-3 py-2 last:border-0",
              i === state.currentIndex && "bg-primary/10"
            )}
          >
            {!locked && canEdit && (
              <span
                draggable
                onDragStart={() => {
                  dragIndexRef.current = i;
                }}
                onDragEnd={() => {
                  dragIndexRef.current = null;
                }}
                title="ลากเพื่อสลับลำดับ (เดสก์ท็อป) — มือถือใช้ปุ่ม ▲▼"
                className="-ml-1 shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </span>
            )}
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

            <div className="flex shrink-0 items-center gap-1">
              {/* quick reorder — Admin + Manual + controller only (detailed edits = setlist editor) */}
              {!locked && canEdit && (
                <div className="flex flex-col">
                  <button
                    onClick={() => moveItem(i, -1)}
                    disabled={i === 0}
                    title="เลื่อนขึ้น"
                    className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => moveItem(i, 1)}
                    disabled={i === items.length - 1}
                    title="เลื่อนลง"
                    className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {isPlayingThis && (
                <Volume2 className="h-3.5 w-3.5 animate-pulse text-primary" />
              )}
              {hasFile && canEdit && (
                <button
                  onClick={() => toggleLoop(it.id)}
                  disabled={locked}
                  title={
                    locked
                      ? "ตั้ง Loop ได้ตอน Manual เท่านั้น"
                      : it.loop_audio
                        ? "Loop เปิด — วนจนครบเวลาแล้วเฟดจบเอง (แตะเพื่อปิด)"
                        : "Loop ปิด — แตะเพื่อให้วนจนครบเวลา (เฟดจบเอง)"
                  }
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
                    it.loop_audio
                      ? "text-primary"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  <Repeat className="h-3.5 w-3.5" />
                </button>
              )}
              {canEdit ? (
                <button
                  onClick={() => openFilePicker(it.id)}
                  disabled={!!busy}
                  title={
                    busy === "up"
                      ? "กำลังอัปโหลดขึ้นคลาวด์…"
                      : busy === "down"
                        ? "กำลังดาวน์โหลดจากคลาวด์…"
                        : it.audio_path && !hasLocal
                          ? "มีไฟล์บนคลาวด์ (จะดาวน์โหลดให้อัตโนมัติ) — แตะเพื่อเปลี่ยนไฟล์"
                          : hasFile
                            ? "เปลี่ยนไฟล์เพลง (อัปโหลดขึ้นคลาวด์)"
                            : "โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)"
                  }
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
                    hasFile
                      ? "text-primary"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, state, playingId, audioPlaying, audioUrls, audioBusy, isController]
  );

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

      {/* rehearsal notice — non-admins may play/รัน to rehearse but never edit live */}
      {!canEdit && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          โหมดซ้อม — เล่น/รันเพื่อซ้อมจับเวลาได้ แต่ปรับลำดับ/เปลี่ยนไฟล์/บันทึก “จบโชว์” สงวนไว้สำหรับแอดมิน
        </div>
      )}

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

      {/* "What is this device right now" — Show Main / Audio Host / online / sync. */}
      <LiveStatusStrip isController={isController} soundOutput={soundOutput} />

      {/* Audio needs a tap to (re)start — after a reload / autoplay block. Big target. */}
      {needsAudioResume && (
        <button
          onClick={resumeAudio}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400 bg-amber-500 px-4 py-3 text-base font-bold text-black shadow-sm animate-pulse hover:bg-amber-400"
        >
          <Volume2 className="h-5 w-5" /> แตะเพื่อเล่นเสียงต่อ (ตำแหน่งปัจจุบัน)
        </button>
      )}

      {/* Realtime dropped mid-show — make it obvious; the local show keeps running */}
      {state.begun && !syncReady && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
          การเชื่อมต่อหลุด — กำลังต่อใหม่ (โชว์ยังเดินต่อ)
        </div>
      )}

      {/* Pre-flight audio readiness — read-only: does THIS device hold every track's
          file so the show plays offline? Before START it always shows; once running it
          only warns if something's still missing. Derived from existing state. */}
      {(() => {
        const audioItems = items.filter((it) => it.audio_path);
        if (audioItems.length === 0) return null;
        const total = audioItems.length;
        const ready = audioItems.filter((it) => audioUrls[it.id]).length;
        const allReady = ready === total;
        if (allReady && state.begun) return null; // don't nag once running & all set
        const downloading = audioItems.some((it) => audioBusy[it.id] === "down");
        return (
          <div
            className={cn(
              "flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium",
              allReady
                ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
                : "border-amber-400 bg-amber-500/10 text-amber-800 dark:text-amber-300"
            )}
          >
            {allReady ? (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                เสียงพร้อมครบ {total} เพลง — เล่นได้แม้เน็ตหลุด
              </>
            ) : downloading ? (
              <>
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                กำลังโหลดเสียงลงเครื่อง {ready}/{total}…
              </>
            ) : (
              <>
                <HardDriveDownload className="h-4 w-4 shrink-0" />
                เสียงในเครื่องนี้ {ready}/{total} — อีก {total - ready} เพลงจะดึงจากเน็ตตอนเล่น
              </>
            )}
          </div>
        );
      })()}

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
        <p className="text-5xl font-bold tabular-nums sm:text-6xl lg:text-7xl">
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
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-left text-[10px] opacity-60">
                      <Music2 className="mr-1 inline h-3 w-3" />
                      {audioNames[current.id]}
                    </p>
                  </div>
                ) : currentBusy === "down" ? (
                  // an online file exists; this device is fetching it
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-left text-[10px] opacity-60">
                      <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> กำลังดาวน์โหลดเพลงจากคลาวด์…
                    </p>
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
                      title="เปลี่ยน/อัปโหลดไฟล์เพลงสำหรับรายการนี้"
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] opacity-70 hover:bg-white/15 hover:opacity-100"
                    >
                      <FolderOpen className="h-3 w-3" /> โหลดไฟล์ที่นี่
                    </button>
                  </div>
                )}
              </div>
            ) : currentBusy === "down" || currentHasOnline ? (
              // an online file exists for this item — it auto-downloads to this device
              <span className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/10 px-3 py-1.5 text-xs opacity-70">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังเตรียมไฟล์เพลงจากคลาวด์…
              </span>
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
                ) : audioBusy[next.id] === "down" || next.audio_path ? (
                  <>
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> กำลังเตรียมไฟล์จากคลาวด์…
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

        {/* control row — per-device sound output (left) + run mode. Sound is LOCAL
            per device (not broadcast): the PA device ON, a remote OFF to stay silent
            without muting the PA. Mode is controller-only. */}
        <div className="mb-2 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setSoundOutput((v) => !v)}
            title={
              soundOutput
                ? "เสียงออกที่เครื่องนี้ — แตะเพื่อปิดเสียงเฉพาะเครื่องนี้"
                : "เครื่องนี้เงียบอยู่ — แตะเพื่อให้เสียงออก"
            }
            className={cn(
              "flex h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-sm font-semibold transition-colors",
              soundOutput
                ? "border-green-600 bg-green-600 text-white hover:bg-green-700"
                : "border-muted-foreground/30 bg-muted text-muted-foreground hover:bg-muted/70"
            )}
          >
            {soundOutput ? (
              <>
                <Volume2 className="h-4 w-4 shrink-0" /> เสียงออก
              </>
            ) : (
              <>
                <VolumeX className="h-4 w-4 shrink-0" /> ปิดเสียง
              </>
            )}
          </button>
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
            <Sparkles className="h-4 w-4" /> Auto
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
        {/* จบโชว์ — freezes + saves the accumulated time as the last-show record below.
            Not a reset: Reset Show (↺) still clears the live state separately. */}
        {state.begun && isController && canEdit && (
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
            ? "Auto: เปลี่ยนรายการเองเมื่อเพลงจบ — กด Manual เพื่อคุมเอง"
            : "Manual: กด NEXT เพื่อข้ามรายการ — ซิงค์หลายเครื่องอัตโนมัติ"}
        </p>
        {isController && (
          <p className="mt-1 hidden text-center text-[11px] text-muted-foreground/70 sm:block">
            ⌨️ คีย์ลัด: <kbd className="rounded border px-1">Space</kbd> เริ่ม/รัน ·{" "}
            <kbd className="rounded border px-1">→</kbd>/<kbd className="rounded border px-1">N</kbd> ถัดไป ·{" "}
            <kbd className="rounded border px-1">←</kbd> ย้อน
          </p>
        )}
      </div>

      {/* upcoming list (memoized — see upcomingRows) */}
      <div className="rounded-xl border bg-card">{upcomingRows}</div>

      {/* last-show time record — saved by จบโชว์, survives a normal Reset Show,
          cleared only by its own ล้าง button. (Stored per device.) */}
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
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearLastRun}
              className="shrink-0 text-muted-foreground"
              title="ล้างเวลาโชว์ล่าสุดที่บันทึกไว้"
            >
              ล้าง
            </Button>
          )}
        </div>
      )}

      <p className="px-1 text-center text-[11px] text-muted-foreground">
        <CloudUpload className="mr-1 inline h-3 w-3" />
        ไฟล์เพลงเก็บออนไลน์แบบส่วนตัว (เฉพาะคนที่ล็อกอิน) — ทุกเครื่องเล่นได้ และลบได้
      </p>
    </div>
  );
}
