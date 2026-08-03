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
import { hasLiveSession } from "@/lib/auth-session";
import { shouldMuteOnStepDown, shouldYieldControl } from "@/lib/live-arbitration";
import { saveAudio, loadAudioForEvent } from "@/lib/audio-store";
import { getCachedSongBlob } from "@/lib/song-cache";
import { getLocalSource, listLocalSourceIds } from "@/lib/local-source";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import { persistLastRun } from "@/lib/show-run-outbox";
import { setLiveShowActive } from "@/lib/live-guard";
import { getDeviceId, deviceLabel } from "@/lib/device-id";
import {
  claimAuthority,
  heartbeatAuthority,
  releaseAuthority,
} from "@/lib/show-authority";
import {
  buildSongAudioPath,
  uploadEventAudio,
  downloadEventAudio,
  removeEventAudio,
} from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LiveStatusStrip } from "@/components/event/live-status-strip";
import { AudioOutputPicker, AUDIO_SINK_KEY, loadAudioSink } from "@/components/event/audio-output-picker";
import { cn } from "@/lib/utils";
import { liveTopic, privateChannel, songsTopic } from "@/lib/realtime";
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
  // Gate START SHOW until this device has had a chance to hear about a show already
  // running elsewhere: starting before the first sync round-trip would stamp a NEWER
  // controllerSince that beats the real controller's older claim — hijacking/resetting
  // a live show to item 0 and muting its speaker. Settles when: a state broadcast is
  // heard · the sync-request reply window passes in silence · the channel fails
  // (offline shows must still start) · a hard fallback timeout.
  const [syncSettled, setSyncSettled] = useState(false);
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
  // When this device became the ACTIVE controller (began the show or took control).
  // null = never actively claimed: a fresh device defaults to isController=true but
  // must YIELD to any device that actually began/claimed. Settles the race where two
  // default-controller devices press "เริ่มโชว์" at the same instant — the more-recent
  // claim wins (ties broken by sender id) so exactly one stays in control instead of
  // both demoting each other into a silent, uncontrolled show.
  const controllerSinceRef = useRef<number | null>(null);
  // when THIS page instance opened — a control claim older than this was made before
  // we (re)loaded, i.e. we're re-joining an existing arrangement, not being taken over.
  const mountedAtRef = useRef<number>(Date.now());
  const meId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random())
  );

  // audio state — two elements so an incoming track can overlap (negative buffer)
  // without cutting the current one. audioRef = primary (drives the UI scrubber).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioRef2 = useRef<HTMLAudioElement | null>(null);
  const overlapNextIdRef = useRef<string | null>(null); // pre-roll PROVEN to be sounding
  // What is loaded on the secondary right now, set synchronously at pre-roll time.
  // The claim above waits for play() to resolve; this does not, so goto() can always
  // silence a pre-roll it isn't going to promote (otherwise the same track plays on
  // both elements at once).
  const preRollIdRef = useRef<string | null>(null);
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
  // which download-effect run set an item's busy flag — so a superseded run can
  // still clear its own flag without clobbering a newer run's active download
  const downloadRunRef = useRef(0);
  const busyOwnerRef = useRef<Record<string, number>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playingIdRef = useRef(playingId); // for the "ended" listener's stale closure
  playingIdRef.current = playingId;
  // the item whose audio reached its NATURAL end — a viewer must not loop-restart it
  // (the show item can outlast the file via buffer_after). Cleared on the next command.
  const endedItemRef = useRef<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  // A REAL media failure on THIS device (a dangling cached blob, an evicted file, a
  // codec this device can't decode) — as opposed to the benign autoplay block, which
  // the "แตะเพื่อเล่นเสียงต่อ" banner already handles. Kept on screen because the
  // alternative is pure silence with the countdown still running and nothing saying
  // why. Purely informational: it never touches the show clock or the advance logic.
  const [audioFault, setAudioFault] = useState<{ id: string; title: string } | null>(null);
  const audioFaultRef = useRef<string | null>(null); // itemId already reported (dedupe)
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>({}); // itemId → 0–100 (default 100), set per track
  // Per-DEVICE sound output (local, NOT broadcast): is this device the one that
  // actually makes sound (e.g. plugged into the PA)? A remote/control device sets
  // this OFF so it stays silent without muting the PA device. Default ON.
  const [soundOutput, setSoundOutput] = useState(true);
  // Per-device OUTPUT ROUTING (desktop): pin the show audio to a chosen output
  // device via setSinkId ("" = system default = today's behavior), so a Bluetooth
  // headset / HDMI screen connecting mid-show can't silently steal the PA feed.
  const [sinkId, setSinkId] = useState("");
  const sinkLoadedRef = useRef(false); // don't persist before the saved value loads
  // Crossfade (opt-in, per device, default OFF = the old hard cut): on a track
  // change the outgoing song fades out (~2s) while the new one starts.
  const [crossfade, setCrossfade] = useState(false);
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

  // The single writer for the volume presets — shared by the debounce below and the
  // flush-on-hide further down, so the two can never drift apart.
  function writeVolumePreset() {
    if (!volumesLoadedRef.current) return; // don't overwrite before the restore runs
    try {
      // A loop item's end-fade (loopFadeRef, declared with its effect further down)
      // is TRANSIENT: it dips that track to 0 so the BGM lands on time and restores
      // once the show moves off it. When it never moves off (last item, or the
      // operator leaves it running) the restore never fires, and persisting that 0
      // would re-open the event with the row muted. Save the operator's INTENDED
      // level for a track that's mid-fade — the audible fade itself is untouched.
      const lf = loopFadeRef.current;
      const vols = volumesRef.current;
      const preset = lf ? { ...vols, [lf.id]: lf.prevVol } : vols;
      localStorage.setItem(`cueiq:vol:${eventId}`, JSON.stringify(preset));
    } catch {}
  }
  const writeVolumePresetRef = useRef(writeVolumePreset);
  writeVolumePresetRef.current = writeVolumePreset;

  // persist volume presets, debounced (the fade buttons update this ~60fps — only
  // the settled value is written). Survives refresh so soundcheck levels stick.
  useEffect(() => {
    if (!volumesLoadedRef.current) return;
    const id = setTimeout(() => writeVolumePresetRef.current(), 400);
    return () => clearTimeout(id);
  }, [volumes, eventId]);

  // Crash/reload recovery: restore a recently-running show so an accidental refresh
  // (or a browser crash) doesn't reset the live position + accumulated time. The
  // timestamps are absolute, so the clock resumes as if nothing happened; a live
  // controller on another device still overrides this via the realtime sync.
  const liveRestoredRef = useRef(false);
  // true only when a running show was actually resumed from THIS device's snapshot —
  // i.e. this device was already part of the run before it reloaded. Used by the sync
  // handler to decide whether stepping down should silence it (see "เครื่องเสียง
  // คุมคนเดียว"); a `begun` adopted from someone else's broadcast must not count.
  const resumedRunRef = useRef(false);
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
          resumedRunRef.current = true;
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

  // The single writer for the crash-recovery snapshot (see the flush-on-hide below).
  function writeLiveSnapshot() {
    if (!liveRestoredRef.current) return; // don't write before the restore check ran
    try {
      const s = stateRef.current;
      if (s.begun) {
        localStorage.setItem(
          `cueiq:live:${eventId}`,
          JSON.stringify({
            state: s,
            committed: committedRef.current,
            savedAt: Date.now(),
          })
        );
      } else {
        localStorage.removeItem(`cueiq:live:${eventId}`);
      }
    } catch {}
  }
  const writeLiveSnapshotRef = useRef(writeLiveSnapshot);
  writeLiveSnapshotRef.current = writeLiveSnapshot;

  // persist the running show (debounced); a reset (begun=false) clears it
  useEffect(() => {
    if (!liveRestoredRef.current) return;
    const id = setTimeout(() => writeLiveSnapshotRef.current(), 500);
    return () => clearTimeout(id);
  }, [state, eventId]);

  // Both persists above are debounced, and a phone can outrun the debounce: iOS
  // Safari never acts on `beforeunload`, so a pull-to-refresh or a tab close within
  // half a second of the last advance would come back one cue behind. pagehide and
  // visibilitychange ARE delivered there, and localStorage.setItem is synchronous,
  // so flushing on them costs nothing and closes the window. Registered once —
  // both writers read the live values off refs.
  useEffect(() => {
    const flush = () => {
      writeLiveSnapshotRef.current();
      writeVolumePresetRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // stop any running fade / pending volume broadcast on unmount
  useEffect(() => {
    const vb = volBcastRef.current; // stable object (never reassigned, only mutated)
    return () => {
      if (fadeRef.current) cancelAnimationFrame(fadeRef.current);
      if (vb.timer) clearTimeout(vb.timer);
    };
  }, []);

  // Tell the operator WHICH track died and that this device is now silent. Reported
  // once per track (the media "error" event and the play() rejection normally both
  // fire for the same file); cleared when the show moves on to another track.
  function reportAudioFault(itemId: string | null) {
    if (!itemId || audioFaultRef.current === itemId) return;
    audioFaultRef.current = itemId;
    const title = itemsRef.current.find((it) => it.id === itemId)?.title || "รายการนี้";
    setAudioFault({ id: itemId, title });
    toast.error(`เล่นไฟล์เสียงไม่สำเร็จ: ${title}`, {
      description: "เครื่องนี้จะไม่มีเสียงในรายการนี้ (โชว์ยังเดินต่อ) — ลองโหลดไฟล์เพลงใหม่",
    });
  }
  const reportAudioFaultRef = useRef(reportAudioFault);
  reportAudioFaultRef.current = reportAudioFault;

  // A play() rejection is not always a failure: NotAllowedError = the autoplay policy
  // (the "แตะเพื่อเล่นเสียงต่อ" banner is the affordance for that, so it stays silent
  // here) and AbortError = our own pause / src-swap interrupting a pending play, which
  // happens on every track change and overlap. Anything else is a real media failure.
  /**
   * `sounding` = this play() was meant to put audio out of the speakers right now.
   * A PRE-ROLL on the secondary element is not: the current track is still playing
   * happily, so a refusal there must not tell the operator the show has gone quiet.
   */
  function onPlayRejected(itemId: string | null, err: unknown, sounding = true) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError") return;
    if (name === "NotAllowedError") {
      if (!sounding) return;
      // The rescue affordance for this already exists — needsAudioResume renders
      // "แตะเพื่อเล่นเสียงต่อ", and resumeAudio() plays from the committed position
      // inside the operator's own tap. But it is gated on !audioPlaying, and every
      // play site sets that flag true SYNCHRONOUSLY, before the promise settles. So
      // the one case that needed the banner was the one case that suppressed it:
      // countdown running, row lit, PA silent, and nothing on screen to press.
      // Telling the truth here is what turns a dead show back into one tap.
      setAudioPlaying(false);
      return;
    }
    reportAudioFault(itemId);
  }
  // ref for the effects with a curated dep list (they must not re-run per render)
  const onPlayRejectedRef = useRef(onPlayRejected);
  onPlayRejectedRef.current = onPlayRejected;

  // the fault describes ONE track — drop it once the show is sounding another one,
  // so a stale banner doesn't sit over the rest of the run
  useEffect(() => {
    if (audioFaultRef.current && audioFaultRef.current !== playingId) {
      audioFaultRef.current = null;
      setAudioFault(null);
    }
  }, [playingId]);

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
      a.addEventListener("error", () => {
        // The loaded file can't be played at all (dangling blob, undecodable bytes,
        // missing codec). Only the element that's meant to be SOUNDING counts — an
        // idle one being reloaded or cleared (src="" on unmount) isn't a fault.
        if (a !== audioRef.current || !playingIdRef.current) return;
        reportAudioFaultRef.current(playingIdRef.current);
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
      // Sound is a fact about the element, not about what we asked it to do. These
      // two make audioPlaying follow reality, so the "แตะเพื่อเล่นเสียงต่อ" rescue
      // can appear for anything that stops the audio without going through us.
      a.addEventListener("playing", () => {
        if (a === audioRef.current) setAudioPlaying(true);
      });
      a.addEventListener("pause", () => {
        // Every app-initiated stop passes through here too — playItemAudio pauses
        // before swapping src, and the viewer path pauses on a controller pause —
        // so judging immediately would flash the banner on every track change.
        // Re-check on the next macrotask instead: by then a real track change has
        // already started playing again (a.paused === false) and self-suppresses,
        // while an outside interruption (a call, the lock screen, a headphone
        // button, Control Centre) is still paused and is exactly what we want to
        // surface. Deliberate stops set the flag themselves, so agreeing is a no-op.
        setTimeout(() => {
          if (a !== audioRef.current || !a.paused || a.ended) return;
          if (!playingIdRef.current || endedItemRef.current === playingIdRef.current) return;
          setAudioPlaying(false);
        }, 400);
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
      if (localStorage.getItem("cueiq:crossfade") === "1") setCrossfade(true);
      setSinkId(loadAudioSink());
    } catch {
      /* ignore */
    }
    sinkLoadedRef.current = true;
  }, []);

  // Route BOTH elements to the chosen output device + persist the choice.
  // setSinkId is Chromium-only (the desktop app; on web sinkId stays "" and this
  // is a no-op). A failed route falls back to the system default and keeps
  // playing — output routing must never be the reason a show goes silent.
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
    // Tell out-of-tree actions (the header Sign-out button) that a sounding show is
    // live here, so they confirm before cutting it — the click/beforeunload guards
    // below can't see a programmatic sign-out navigation.
    setLiveShowActive(true);
    const livePath = `/events/${eventId}/live`;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && !(a.getAttribute("href") ?? "").includes(livePath)) {
        const href = a.getAttribute("href") || "";
        // Confirm-and-allow: leaving Live Mode cuts the audio on this sound device,
        // so warn before going — but DO let the user leave (the old hard block felt
        // like a dead button). On confirm, navigate to the link we intercepted; the
        // href works as-is on web (/path) and desktop (#/path under HashRouter).
        e.preventDefault();
        e.stopPropagation();
        if (
          window.confirm(
            "ออกจาก Live Mode ตอนนี้? เสียงที่กำลังเล่นบนเครื่องนี้จะหยุด"
          )
        ) {
          window.location.href = href;
        }
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setLiveShowActive(false);
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
  // set by that cleanup: a download still in flight must not mint an object URL
  // AFTER the revoke-all pass, or its (up to ~80MB) blob is pinned for good.
  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
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
          // Records written BEFORE the copy-on-pick fix below hold the picked File
          // itself = a mere REFERENCE to the on-disk path (Chromium). A moved /
          // deleted / re-exported source (or an unplugged USB stick) still mints an
          // object URL here yet plays nothing at showtime — the same trap Quick Show
          // migrates on boot (desktop/src/pages/my-show.tsx). When we know the online
          // version, leave cachedPathRef UNSET so the download effect below counts it
          // as missing and re-pulls real bytes, overwriting the dangling record. The
          // URL above still stands, so a source that IS still there keeps playing
          // until that lands. A path-less record is local-only legacy — that
          // reference is the only copy that exists, so it's kept as before.
          const dangling =
            s.path != null && typeof File !== "undefined" && s.blob instanceof File;
          if (!dangling) cachedPathRef.current[s.itemId] = s.path; // which online version we hold
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

  // ⭐#1 step 7 — songs whose ONLY copy is a file picked on THIS device (an upload
  // queued while offline, or the desktop "ใช้ไฟล์ในเครื่องนี้" override). Live Mode
  // used to bail on `!audio_path` before it ever asked lib/local-source, so the one
  // case the offline upload queue exists for produced a row that looked ready in the
  // Library and played nothing on stage. Re-read on every queue change so a file
  // picked in the Library reaches an already-open Show Runner.
  const [localSongIds, setLocalSongIds] = useState<Set<string>>(new Set());
  const localSongIdsRef = useRef(localSongIds);
  localSongIdsRef.current = localSongIds;
  // The first read is ASYNC (IndexedDB), and audioSig below is the download
  // effect's only dependency — so without this gate the effect runs once with an
  // empty set, then AGAIN when the set lands, and that second run re-issues a full
  // presign + GET for the first ordinary master, which is still in flight. Two
  // copies of the same 88 MB file halving each other's bandwidth is the last thing
  // a venue link needs. Hold the effect until the answer exists (a few ms, and it
  // settles even when IndexedDB is unavailable).
  const [localsRead, setLocalsRead] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listLocalSourceIds()
        .then((ids) => {
          if (!alive) return;
          setLocalSongIds(ids);
          setLocalsRead(true);
        })
        .catch(() => {
          if (alive) setLocalsRead(true); // no local sources ≠ never start
        });
    };
    refresh();
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, []);

  /** Which bytes this row should be holding: the R2 key, or a local-only marker. */
  function audioVersionOf(it: { song_id?: string | null; audio_path?: string | null }) {
    if (it.audio_path) return it.audio_path;
    if (it.song_id && localSongIdsRef.current.has(it.song_id)) return `local:${it.song_id}`;
    return null;
  }

  // What the download effect actually depends on: which item wants which file.
  // refetchItems() mints a BRAND-NEW items array on every refetch (tab focus,
  // "setlist-changed", library broadcast), so keying the effect on `items` restarted
  // — and abandoned — an in-flight download of an 80MB master every time the operator
  // switched apps. Keyed on this signature, a refetch that changed no audio leaves
  // the running download alone. Local-only rows ride the same signature, so bytes
  // that appear while this screen is open pull themselves in.
  const audioSig = useMemo(
    () =>
      items
        .map(
          (it) =>
            `${it.id}:${
              it.audio_path ??
              (it.song_id && localSongIds.has(it.song_id) ? `local:${it.song_id}` : "")
            }`
        )
        .join("|"),
    [items, localSongIds]
  );

  // Download any online audio this device doesn't already hold (or holds a stale
  // version of). Runs whenever the setlist's audio changes — so a file uploaded on
  // another device appears here after the "setlist-changed" refetch. Best-effort: a
  // failure just leaves whatever local copy exists.
  useEffect(() => {
    if (!localsRead) return; // see localsRead — don't start on a signature that is about to change
    let cancelled = false;
    const runId = ++downloadRunRef.current;
    (async () => {
      for (const it of items) {
        const path = it.audio_path;
        // ⭐#1 step 7: no online master, but this device holds the file — the bytes
        // are already here, there is simply nothing to download.
        const version = audioVersionOf(it);
        if (!version) continue;
        // LOCK the on-air file: never re-download or revoke the track that's
        // currently sounding (a mid-show library re-upload won't cut the live song).
        if (it.id === playingIdRef.current && audioUrlsRef.current[it.id]) continue;
        // already holding this exact version locally? skip.
        if (cachedPathRef.current[it.id] === version && audioUrlsRef.current[it.id]) continue;
        setAudioBusy((prev) => ({ ...prev, [it.id]: "down" }));
        busyOwnerRef.current[it.id] = runId;
        try {
          // Source order: a per-device local override (desktop "ใช้ไฟล์ในเครื่องนี้",
          // or an upload still queued from a venue with no wifi) wins; else the
          // band-library prefetch cache; else hit the network. This only swaps which
          // BYTES load — the transport/position logic below is untouched (the
          // zero-tolerance single-audio-source path stays intact).
          const local = await getLocalSource(it.song_id);
          // A local-only row with no bytes left (the queue flushed and cleared the
          // override between the id listing and here) has no second source to try.
          if (!path && !local) continue;
          const blob = path
            ? (local?.blob ?? (await getCachedSongBlob(path)) ?? (await downloadEventAudio(path)))
            : local!.blob;
          // The bytes are HERE. Even if this run was superseded meanwhile, KEEP them:
          // dropping them un-cached meant re-downloading the whole master from zero on
          // venue wifi. Only discard when the item now wants a DIFFERENT file (a
          // mid-show replace), where what we just fetched is genuinely stale.
          const wanted = itemsRef.current.find((x) => x.id === it.id)?.audio_path;
          if (cancelled && wanted !== path) return;
          const name = it.audio_name ?? local?.name ?? "เพลง";
          cachedPathRef.current[it.id] = version;
          // path stays NULL for a local-only row — that is how audio-store marks
          // "the only copy that exists", and audio-prefetch's orphan sweep skips
          // exactly those records rather than deleting bytes it can't re-fetch.
          saveAudio(eventId, it.id, blob, name, path).catch(() => {});
          // Left Live Mode while this was transferring: the bytes are safely cached
          // for next time, but an object URL minted now would outlive the unmount
          // revoke-all above and never be freed.
          if (unmountedRef.current) return;
          const url = URL.createObjectURL(blob);
          if (audioUrlsRef.current[it.id]) URL.revokeObjectURL(audioUrlsRef.current[it.id]);
          setAudioUrls((prev) => ({ ...prev, [it.id]: url }));
          setAudioNames((prev) => ({ ...prev, [it.id]: name }));
          if (cancelled) return; // committed — but let the newer run drive the rest
        } catch {
          /* keep any existing local copy */
        } finally {
          // Clear even when this run was CANCELLED: the on-air item is skipped by
          // the re-run (lock above), so its stale flag would otherwise spin forever
          // and dead-lock the row's file button. Ownership check: never clear a
          // flag a newer run has since re-set for its own download.
          if (busyOwnerRef.current[it.id] === runId) {
            delete busyOwnerRef.current[it.id];
            setAudioBusy((prev) => {
              const n = { ...prev };
              delete n[it.id];
              return n;
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `items` is read inside but deliberately NOT a dep — see audioSig above (a
    // refetch that changed no audio must not restart an in-flight download).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSig, eventId, localsRead]);

  // Wake Lock — keep the screen on for as long as the operator is IN the show.
  // Keyed on `begun`, not `running`: the run clock stops between every Manual cue
  // and on every pause, and dropping the lock there let the phone dim and auto-lock
  // in exactly the gaps where the operator is waiting to press the next cue —
  // needing a wake, a passcode and a re-render to run their own show. `begun` is
  // "show entered", which is the lifetime that was always meant.
  // จบโชว์ leaves `begun` true on purpose (the show stays open with its clock
  // frozen), so the lock's `begun` lifetime would otherwise run until reset or
  // unmount — on every viewer phone in the band, not just the operator's.
  const [showEnded, setShowEnded] = useState(false);
  const showEndedRef = useRef(showEnded);
  showEndedRef.current = showEnded;
  /** Flip it on the REF as well as in state. Every caller changes it and
   *  broadcasts in the same tick, and statePayload reads the ref — a React state
   *  update is still the old value by then, so a fresh เริ่มโชว์ would announce
   *  "the show is over" to every viewer the instant it started. */
  function markShowEnded(v: boolean) {
    showEndedRef.current = v;
    setShowEnded(v);
  }
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!state.begun || showEnded) {
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
  }, [state.begun, showEnded]);

  // re-acquire Wake Lock when returning to the tab (browser auto-releases it on hide)
  useEffect(() => {
    function onVisible() {
      if (
        document.visibilityState === "visible" &&
        stateRef.current.begun &&
        !showEndedRef.current &&
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

  // Persist this device's SHOW-MAIN authority while it's the controller of a begun
  // show (P2). Best-effort + layered ON TOP of the existing broadcast control — it
  // never gates the live path; it only lets other devices SEE who's main on join/
  // reconnect and detect a ghost main (stale heartbeat) for recovery. The realtime
  // hand-off still happens via the live: channel; this is the synced mirror.
  const deviceIdRef = useRef<string>("");
  if (!deviceIdRef.current) deviceIdRef.current = getDeviceId();
  useEffect(() => {
    if (!(isController && state.begun)) return;
    const tenantId = itemsRef.current[0]?.tenant_id;
    if (!tenantId) return; // no setlist → nothing to run / claim
    const did = deviceIdRef.current;
    const info = { deviceId: did, deviceLabel: deviceLabel() };
    claimAuthority(tenantId, eventId, "show_main", info);
    const hb = setInterval(() => {
      heartbeatAuthority(eventId, "show_main", did);
    }, 30000);
    return () => {
      clearInterval(hb);
      // only deletes if WE still hold it — a hand-off that already moved the row to
      // the new main is left intact (releaseAuthority matches on our device_id).
      releaseAuthority(eventId, "show_main", did);
    };
  }, [isController, state.begun, eventId]);

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
        // Synchronous record of WHAT is loaded on the secondary — needed by goto()
        // to stop a pre-roll it decides not to promote. Distinct from
        // overlapNextIdRef, which means "proven to be sounding".
        preRollIdRef.current = nxt.id;
        // Claim SYNCHRONOUSLY and retract on failure — not the other way round. A
        // play() promise resolves only once audio actually begins, which on an 88 MB
        // master is easily longer than the remaining lead, so waiting for it would
        // leave goto() thinking there was no pre-roll: it would hard-cut the same
        // track on the primary while the secondary carried on, and the PA would get
        // two offset copies of one song. Retracting on the catch keeps the seamless
        // hand-off everywhere it worked before, and a WebKit-refused pre-roll leaves
        // the element PAUSED — which is what goto() actually checks below.
        overlapNextIdRef.current = nxt.id; // promoted to primary on advance
        sec.play().catch((err) => {
          if (overlapNextIdRef.current === nxt.id) overlapNextIdRef.current = null;
          onPlayRejectedRef.current(nxt.id, err, false); // the current track is still sounding
        });
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
        // No optimistic true here. This device is the one wired to the PA, and it
        // is following a command from ANOTHER device — nobody has touched this
        // screen, which is precisely the case WebKit refuses. Claiming it plays
        // hid the "แตะเพื่อเล่นเสียงต่อ" banner (gated on !audioPlaying) and left
        // the room silent while every indicator here said the show was running.
        // The element's own "playing" event sets the flag when sound really starts.
        audio.play().catch((err) => onPlayRejected(cmd.id, err));
      } else {
        // same track already loaded — follow PLAY only; NEVER touch the position.
        if (audio.paused) audio.play().catch((err) => onPlayRejected(cmd.id, err));
        else if (!audioPlaying) setAudioPlaying(true);
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
    const ch = privateChannel(supabase, liveTopic(eventId));
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload || payload.sender === meId.current) return;
      setSyncSettled(true); // heard live show state — the first sync has landed
      const fromController = !!payload.fromController;
      // A viewer's sync-reply (fromController=false) is only useful to a device that
      // hasn't picked up the show yet — never let it overwrite or demote an active
      // session. This is what keeps the controller in control after a reconnect:
      // its own sync-request gets viewer replies, which we now ignore.
      if (!fromController && stateRef.current.begun) return;
      // Correct for clock differences between devices: the sender stamps its own
      // Date.now() as sentAt; we shift its absolute timestamps into OUR clock so
      // both screens count down in step even if their system clocks disagree.
      const skew =
        typeof payload.sentAt === "number" ? Date.now() - payload.sentAt : 0;
      // An ACTIVE controller is driving → step down to a read-only viewer so we can't
      // fight it. (We do NOT pause audio: a speaker-wired device keeps playing and
      // follows the new controller's commands — see the viewer audio-sync effect.)
      if (fromController && isControllerRef.current) {
        // Two devices both think they're the controller (e.g. both pressed "เริ่มโชว์"
        // before either's broadcast arrived, or both RELOADED and restored the same
        // running show). Settled by shouldYieldControl, which guarantees exactly one
        // of the pair steps down — the rule used to be "mine == null always yields",
        // and two reloaded devices are both null, so both stepped down and the show
        // ran with nobody driving it. Pure + tested in lib/live-arbitration.ts.
        const mine = controllerSinceRef.current;
        const theirs =
          typeof payload.controllerSince === "number" ? payload.controllerSince : null;
        const iYield = shouldYieldControl({
          mine,
          theirs,
          myId: meId.current,
          theirId: String(payload.sender ?? ""),
        });
        if (!iYield) {
          // I hold the stronger claim → keep control and re-assert so the OTHER device
          // steps down. Don't adopt its state — I'm the authority.
          channelRef.current?.send({
            type: "broadcast",
            event: "state",
            payload: statePayload(stateRef.current),
          });
          return;
        }
        isControllerRef.current = false;
        setIsController(false);
        audioRef2.current?.pause(); // stop only any overlap pre-roll on the secondary
        // เครื่องเสียงคุมคนเดียว: whoever took control had to turn their OWN output on
        // to do it, so the sound moves there and this device goes quiet — except for a
        // reloaded speaker handing its default flag back to the incumbent it was
        // already following, which is what silenced a PA mid-show once. The snapshot
        // ref (not state.begun) is the discriminator on purpose: `begun` can be adopted
        // from another device's broadcast, and a phone that merely joined mid-show
        // keeping its sound on would mean two sound hosts. Pure + tested in
        // lib/live-arbitration.ts.
        if (
          shouldMuteOnStepDown({
            mine,
            theirsAtMyClock: theirs != null ? theirs + skew : null,
            resumedOwnSnapshot: resumedRunRef.current,
            mountedAt: mountedAtRef.current,
          })
        ) {
          setSoundOutput(false);
        }
      }
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
      // Follow the controller's จบโชว์ / a fresh เริ่มโชว์, so a viewer's screen is
      // allowed to sleep once the show is over instead of staying lit all night.
      // Absent on an older client → falsy → today's behaviour.
      markShowEnded(!!payload.ended);
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
            controllerSince: controllerSinceRef.current,
            currentItemId: curId,
            ended: showEndedRef.current,
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
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // hard fallback — never leave START bricked if the channel hangs in "init"
    const settleFallback = setTimeout(() => setSyncSettled(true), 6000);
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
        // no reply within the window → no show running elsewhere → START allowed
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => setSyncSettled(true), 2000);
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        // Can't sync (e.g. offline) — a local show must still start. But supabase-js
        // reports these for a TRANSIENT join failure it then retries out of, and
        // settling instantly re-opened the hijack window on a device that IS online.
        // Give the retry a moment: a SUBSCRIBED landing first clears this timer.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => setSyncSettled(true), 3000);
      }
    });
    // REAL-TIME library audio: a group-scoped channel the library broadcasts on
    // when a song's audio is uploaded / replaced / deleted → re-resolve + download
    // live across devices, no reload. (broadcast, not postgres_changes — RLS
    // postgres changes don't deliver with the publishable key.) The on-air track
    // is locked by the download effect, so a mid-show change can't cut the live song.
    const songCh = privateChannel(supabase, songsTopic(groupId));
    songCh.on("broadcast", { event: "changed" }, () => refetchRef.current());
    songCh.subscribe();

    return () => {
      channelRef.current = null;
      setSyncReady(false);
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(settleFallback);
      supabase.removeChannel(ch);
      supabase.removeChannel(songCh);
    };
    // Registered once per (eventId, groupId): every value the handlers read is a ref
    // (stateRef/itemsRef/isControllerRef/controllerSinceRef/meId/refetchRef) or a
    // ref-only helper (audioFields/statePayload), so there is no stale closure to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, groupId]);

  // A broadcast only reaches whoever is listening at that moment, and a phone or
  // tablet suspends a backgrounded socket within seconds — so a second screen put
  // down for one song comes back on the wrong row with its countdown still
  // ticking, and nothing on it looks wrong. Re-ask on wake and on reconnect:
  // whoever is running the show answers with the truth. It also heals the worst
  // case of a network split, where two devices both believe they are the
  // controller — the reply runs the same deterministic settle as any other
  // controller broadcast, so exactly one of them steps down.
  // (Same fix the run-order board already carries — event-live-caller.tsx.)
  useEffect(() => {
    const ask = () => {
      channelRef.current?.send({
        type: "broadcast",
        event: "sync-request",
        payload: { sender: meId.current },
      });
    };
    const onWake = () => {
      if (document.visibilityState === "visible") ask();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", ask);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", ask);
    };
  }, []);

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
      // when we claimed control — lets a competing controller settle the race deterministically
      controllerSince: controllerSinceRef.current,
      currentItemId: itemsRef.current[s.currentIndex]?.id ?? null,
      // จบโชว์ was LOCAL ONLY: it releases the operator's wake lock and leaves
      // every viewer phone in the band holding its screen awake — `begun` stays
      // true on purpose so the show can be reopened with its clock frozen, and
      // that is exactly the lifetime the lock follows. So the band went home with
      // eight phones that never slept. It rides the broadcast now.
      ended: showEndedRef.current,
      ...audioFields(s),
    };
  }

  function apply(next: LiveState, broadcast = true) {
    // Anything that puts the show back into motion un-ends it. จบโชว์ only pauses
    // (begun stays true), so the operator can simply press play again — and
    // without this the whole band's screens would stay asleep through the encore.
    // Before the broadcast below, so the payload agrees with the wake lock.
    if (next.running && showEndedRef.current) markShowEnded(false);
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
  const refetchSeqRef = useRef(0); // monotonic token — only the latest response applies
  // A live reorder (moveItem / reorderTo) is OPTIMISTIC: setItems lands before its
  // UPDATEs are acked, so a refetch fired inside that window (tab focus /
  // "setlist-changed" / library broadcast) can read PRE-write sort_orders and revert
  // the controller's list while the DB — and every other device — already holds the
  // new order; NEXT would then broadcast an index resolving to a different song on
  // the viewers. Same guard as the run-order caller (event-live-caller.tsx):
  // `writesInFlight` defers a refetch ISSUED inside that window and `missedRefetch`
  // makes the write's tail replay it. `writeEpoch` covers the other half — a refetch
  // that was ALREADY reading when the write started. The tail can only replay what it
  // can SEE in missedRefetch, and such a snapshot lands after that check has run, so
  // it re-pulls ITSELF (below) instead of parking a flag nobody reads again: dropping
  // it silently would leave a library upload / a delete made on another device
  // invisible here — the song plays silence, or NEXT resolves to a different row.
  const writesInFlightRef = useRef(0);
  const missedRefetchRef = useRef(false);
  const writeEpochRef = useRef(0); // bumped by each local reorder (moveItem / reorderTo)
  // `depth` only bounds the self-replay below; every other caller omits it.
  async function refetchItems(depth = 0): Promise<void> {
    if (writesInFlightRef.current > 0) {
      // anything we read now can be pre-write — the write's tail re-pulls it
      missedRefetchRef.current = true;
      return;
    }
    const seq = ++refetchSeqRef.current;
    const epoch = writeEpochRef.current;
    missedRefetchRef.current = false;
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
    // a newer refetch was issued while this one was in flight — drop this (older)
    // snapshot so out-of-order responses can't revert the setlist mid-show. The newer
    // one is still reading and applies (or replays) in our place.
    if (seq !== refetchSeqRef.current) return;
    // A local reorder started inside our round trip: these rows predate it, so applying
    // them would revert the controller's list to the pre-write sort_orders — exactly
    // what the write gate exists to stop. Re-read instead of dropping.
    if (writeEpochRef.current !== epoch) {
      // still writing → its tail re-pulls once the UPDATEs ack
      if (writesInFlightRef.current > 0) {
        missedRefetchRef.current = true;
        return;
      }
      // settled, and its tail ran that check before we landed → nobody else will.
      // Bounded: only ANOTHER write landing inside the replay's own round trip can
      // repeat this, and past the cap we park the flag rather than nest for ever.
      if (depth < 3) return refetchRef.current(depth + 1);
      missedRefetchRef.current = true;
      return;
    }
    if (!itemsRes.data) return;
    // An EMPTY read is not the same as an empty setlist. A request that went out
    // as anon — supabase-js quietly falls back to the anon key for the minute
    // after a failed token refresh, which is exactly what a venue wifi blip
    // produces — is refused by RLS as `data: [], error: null`. Applying that here
    // would blank the RUNNING order and wipe every song's audio path: countdown
    // still ticking, list empty, PA silent, and NEXT broadcasting an index that
    // means nothing on the viewers. This refetch is a refresh, not a command —
    // when it comes back empty and we can't prove it was ours, keep what we have.
    // (Only asked when there is something to lose; a truly empty list costs nothing.)
    const wouldEmptyItems = itemsRes.data.length === 0 && itemsRef.current.length > 0;
    const wouldEmptySongs =
      (songsRes.data?.length ?? 0) === 0 &&
      Object.keys(songAudioRef.current).length > 0;
    if (wouldEmptyItems || wouldEmptySongs) {
      if (!(await hasLiveSession())) return;
      // a newer refetch overtook us while we were asking — let it apply instead
      if (seq !== refetchSeqRef.current) return;
    }
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
    // เครื่องเสียงคุมคนเดียว: only the device that's OUTPUTTING sound may drive the
    // show. A muted (view-only) device can't take control — that's exactly what
    // stopped a remote from grabbing control and desyncing the countdown from the
    // real audio. To control from here, turn on "เสียงออกเครื่องนี้" first (the show
    // sound then moves to this device, so audio + control always travel together).
    if (!soundOutput) {
      toast.warning("เครื่องนี้อยู่โหมดดูอย่างเดียว", {
        description: "เปิด “เสียงออกเครื่องนี้” ก่อน ถ้าจะให้เครื่องนี้คุมโชว์ (เสียงจะมาออกที่เครื่องนี้)",
      });
      return;
    }
    controllerSinceRef.current = Date.now(); // fresh claim → wins over the current controller's older stamp
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
    const { data, error } = await supabase
      .from("setlist_items")
      .update({ loop_audio: next })
      .eq("id", itemId)
      .select("id");
    // Same silent-failure shape as a reorder (see reorderLanded) — with the same
    // exception: OFFLINE, the flag stands on this device, because looping the BGM
    // is something the show needs NOW and this screen is built to run without a
    // network. Reverting it there would take a working control away mid-show.
    if (error && isOffline()) {
      toast.warning("ออฟไลน์ — ตั้งเล่นวนไว้เฉพาะเครื่องนี้", { id: "loop-offline" });
      return;
    }
    if (error || (data?.length ?? 0) === 0) {
      setItems((prev) =>
        prev.map((it) => (it.id === itemId ? { ...it, loop_audio: item.loop_audio } : it))
      );
      toast.error("ตั้งค่าเล่นวนไม่สำเร็จ", { description: error?.message });
      return;
    }
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
    // gate concurrent refetches until these UPDATEs land, and invalidate any snapshot
    // already in flight — it predates this write, so it re-reads itself (refetchItems)
    writeEpochRef.current++;
    writesInFlightRef.current++;
    setItems(reordered);
    if (curId) {
      const newIdx = reordered.findIndex((it) => it.id === curId);
      if (newIdx >= 0 && newIdx !== stateRef.current.currentIndex) {
        setState((prev) => ({ ...prev, currentIndex: newIdx }));
      }
    }
    const supabase = createClient();
    const res = await Promise.all([
      supabase
        .from("setlist_items")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id)
        .select("id"),
      supabase
        .from("setlist_items")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id)
        .select("id"),
    ]).finally(() => {
      // clear the gate even if the round-trip threw, or refetches stay deferred
      writesInFlightRef.current--;
    });
    if (!reorderLanded(res)) return;
    bcastSetlistChanged();
    // a refetch landed while we were writing — pull it now that we're settled
    if (missedRefetchRef.current) refetchRef.current();
  }

  /**
   * Did a live reorder actually land? The list was moved OPTIMISTICALLY, and the
   * two ways it can fail are both silent: an error (a demoted account, a dead
   * connection) and a 0-row update — which is what a request sent as anon looks
   * like after a failed token refresh, with no error at all. Either way this
   * device would then broadcast "setlist-changed", every OTHER device would
   * refetch the unchanged server order, and the show would run with two different
   * running orders: the controller's NEXT travels as an INDEX, so the viewers
   * would light up a different song. Say so and pull the board back to server
   * truth instead.
   *
   * OFFLINE is the one failure that is not a failure. A show is meant to run with
   * no network at all, so the new order stands HERE — it just can't reach anyone
   * else. Keep it, say exactly that, and don't try to "restore" from a server we
   * can't even reach.
   */
  function reorderLanded(
    results: { error: { message: string } | null; data: unknown[] | null }[]
  ): boolean {
    const err = results.find((r) => r.error)?.error;
    const missed = results.some((r) => !r.error && (r.data?.length ?? 0) === 0);
    if (!err && !missed) return true;
    if (err && isOffline()) {
      toast.warning("ออฟไลน์ — สลับลำดับแล้วเฉพาะเครื่องนี้", {
        description: "โชว์เดินตามลำดับใหม่ที่นี่ แต่เครื่องอื่นยังเห็นลำดับเดิมจนกว่าเน็ตจะกลับ",
        id: "reorder-offline",
      });
      return false; // nothing to broadcast, nothing to re-pull
    }
    toast.error("เรียงลำดับไม่สำเร็จ", {
      description: err
        ? err.message
        : "อาจไม่มีสิทธิ์แก้ หรือหลุดการเชื่อมต่อชั่วคราว — ดึงลำดับจากเซิร์ฟเวอร์กลับมาแล้ว",
    });
    refetchRef.current();
    return false;
  }

  /** navigator says there's no network — a normal state for this screen, not an error. */
  function isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
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
    // BEFORE the apply below, so the broadcast it sends already carries it.
    markShowEnded(true); // let every screen sleep again — the show is over
    // pause so the accumulated clock stops (does NOT reset the show)
    if (s.running) {
      const frozenItem = s.itemStartedAt
        ? (Date.now() - s.itemStartedAt) / 1000
        : (s.itemElapsedAtPause ?? 0);
      apply({ ...s, running: false, itemElapsedAtPause: frozenItem });
      audioRef.current?.pause();
      audioRef2.current?.pause();
      setAudioPlaying(false);
    } else if (isControllerRef.current) {
      // Ending an already-paused show changes no LiveState, so nothing would be
      // sent at all and the viewers' screens would stay awake regardless. Say it.
      channelRef.current?.send({
        type: "broadcast",
        event: "state",
        payload: statePayload(s),
      });
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
    // same in-flight-write gate as moveItem (see refetchItems)
    writeEpochRef.current++;
    writesInFlightRef.current++;
    setItems(renumbered);
    if (curId) {
      const newIdx = renumbered.findIndex((it) => it.id === curId);
      if (newIdx >= 0 && newIdx !== stateRef.current.currentIndex) {
        setState((p) => ({ ...p, currentIndex: newIdx }));
      }
    }
    const supabase = createClient();
    const res = await Promise.all(
      renumbered
        .filter((it) => orig.find((o) => o.id === it.id)?.sort_order !== it.sort_order)
        .map((it) =>
          supabase
            .from("setlist_items")
            .update({ sort_order: it.sort_order })
            .eq("id", it.id)
            .select("id")
        )
    ).finally(() => {
      // clear the gate even if the round-trip threw, or refetches stay deferred
      writesInFlightRef.current--;
    });
    if (!reorderLanded(res)) return;
    bcastSetlistChanged();
    // a refetch landed while we were writing — pull it now that we're settled
    if (missedRefetchRef.current) refetchRef.current();
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
    // Copy the bytes ONCE for the on-device cache: storing the picked File itself
    // keeps only a REFERENCE to the on-disk path (Chromium), so a source that gets
    // moved / deleted / re-exported — or a USB stick that gets unplugged — leaves a
    // dangling blob that still mints an object URL and still counts as ready in
    // show-readiness-check.tsx, then plays pure silence at showtime. Same fix as
    // Quick Show (desktop/src/pages/my-show.tsx). Best-effort: if the read fails
    // there's simply no offline copy — playback + the upload below use the File.
    let cached: Blob | null = null;
    try {
      cached = new Blob([await file.arrayBuffer()], { type: file.type });
    } catch {
      /* unreadable source — the upload below will surface the real problem */
    }
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
      if (cached) saveAudio(eventId, itemId, cached, file.name, path).catch(() => {});
      if (legacyPath) removeEventAudio(legacyPath).catch(() => {});
      bcastSetlistChanged();
      toast.success("อัปขึ้นคลังเป็นเพลงชั่วคราว (3 วัน) — เก็บถาวรได้ในคลังเพลง");
    } catch (err) {
      // online upload failed — still keep a local-only copy so THIS device can play
      if (cached) saveAudio(eventId, itemId, cached, file.name).catch(() => {});
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
    // Also a real tap, and the one a device that JOINS a show mid-set presses — it
    // never sees start(), so this is its only chance to unlock the second element.
    primeSecondaryAudio();
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
        preRollIdRef.current = null;
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
            audio.play().catch((err) => onPlayRejected(cur.id, err));
            setAudioPlaying(true);
          }
        } else if (url) {
          endedItemRef.current = null;
          // committing a newly-cued track that has audio — play from the offset.
          // Crossfade (opt-in): the previously-sounding track fades out under it.
          if (crossfade && !audio.paused && playingId && playingId !== cur.id) {
            crossfadeSwap(cur.id, url, offset);
          } else {
            audio.src = url;
            audio.currentTime = Math.max(0, offset);
            setPlayingId(cur.id);
            audio.play().catch((err) => onPlayRejected(cur.id, err));
            setAudioPlaying(true);
          }
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
    state.running &&
    !audioPlaying &&
    !!soundingId &&
    !!audioUrls[soundingId] &&
    // …but NOT when the file simply played to its natural end inside a longer
    // slot (buffer_after) — that's normal, not an autoplay block (Quick Show 637ca29)
    endedItemRef.current !== soundingId;

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
      endedItemRef.current = null;
      // already playing this exact item (e.g. started early via negative buffer) — don't restart
      if (playingId === itemId && !audio.paused) {
        setAudioPlaying(true);
        return;
      }
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.play().catch((err) => onPlayRejected(itemId, err));
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

  /**
   * Unlock the SECONDARY audio element. Must be called synchronously inside a real
   * user gesture (the START tap) — that is the whole point.
   *
   * WebKit grants permission to play per ELEMENT, not per page: the primary element
   * is unlocked because the operator's tap starts the first track on it, but the
   * secondary is only ever touched later by a timer — the negative-buffer pre-roll
   * and the crossfade. On an iPhone or iPad those play() calls are refused, and
   * since the refusal used to be swallowed the show handed itself to a silent
   * element mid-set. Playing a moment of silence on it now, inside the tap, means
   * it is already allowed when its turn comes.
   *
   * Idempotent and harmless everywhere else: the element is left paused with no src,
   * exactly as it started, and the errors are ignored.
   */
  /**
   * Is HTMLMediaElement.volume actually writable here? On iOS it is not — the
   * assignment is silently ignored because Apple reserves level control for the
   * hardware buttons. Probed once on a throwaway element (never on the show's own),
   * so nothing about the audio path depends on the answer.
   */
  const [volumeIsDead, setVolumeIsDead] = useState(false);
  useEffect(() => {
    try {
      const probe = new Audio();
      probe.volume = 0.5;
      setVolumeIsDead(probe.volume !== 0.5);
    } catch {
      /* leave it false — never claim a limitation we couldn't establish */
    }
  }, []);

  const SILENT_WAV =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
  const secondaryPrimedRef = useRef(false);
  function primeSecondaryAudio() {
    const b = audioRef2.current;
    if (!b || secondaryPrimedRef.current || b.src) return;
    secondaryPrimedRef.current = true;
    try {
      b.src = SILENT_WAV;
      b.play()
        .then(() => {
          b.pause();
          if (b.src === SILENT_WAV) b.removeAttribute("src");
        })
        .catch(() => {
          if (b.src === SILENT_WAV) b.removeAttribute("src");
        });
    } catch {
      /* nothing here may ever affect the show */
    }
  }

  // Crossfade path (OPT-IN via the toggle; default = playItemAudio's hard cut):
  // start the incoming track on the secondary element, promote it to primary, and
  // fade the outgoing one down (~2s) before stopping it. The negative-buffer
  // overlap pre-roll (its own mechanism) takes precedence over this in Auto.
  const outFadeTokenRef = useRef(0);
  function crossfadeSwap(itemId: string, url: string, fromOffset = 0) {
    const incoming = audioRef2.current;
    if (!incoming || !audioRef.current) return;
    overlapNextIdRef.current = null; // the secondary element is ours now
    preRollIdRef.current = null;
    endedItemRef.current = null;
    incoming.pause();
    incoming.src = url;
    incoming.currentTime = Math.max(0, fromOffset);
    incoming.volume = Math.min(1, Math.max(0, (volumesRef.current[itemId] ?? 100) / 100));
    incoming.play().catch((err) => onPlayRejected(itemId, err));
    swapAudio(); // incoming → primary (scrubber/volume follow it); outgoing → secondary
    setPlayingId(itemId);
    setAudioPlaying(true);
    const el = audioRef2.current; // the outgoing element
    if (!el || el.paused) return;
    const token = ++outFadeTokenRef.current;
    const srcAtStart = el.src;
    const startVol = el.volume;
    const t0 = performance.now();
    const MS = 2000;
    const step = (t: number) => {
      // bow out silently if superseded: a newer crossfade started, or the element
      // was reused (another swap / an overlap pre-roll loaded a new track on it)
      if (outFadeTokenRef.current !== token) return;
      if (el !== audioRef2.current || el.src !== srcAtStart) return;
      const p = Math.min(1, (t - t0) / MS);
      el.volume = startVol * (1 - p);
      if (p < 1) requestAnimationFrame(step);
      else el.pause();
    };
    requestAnimationFrame(step);
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
      .catch((err) => onPlayRejected(sid, err));
  }

  // show-level controls
  function start() {
    // First sync still pending — we don't yet know whether a show is already
    // running elsewhere, and starting now would hijack/reset it to item 0.
    // (Guards the Space shortcut; the START button is also disabled until then.)
    if (!syncSettled) return;
    markShowEnded(false);
    primeSecondaryAudio(); // must happen inside this tap — see the helper
    const ts = Date.now();
    controllerSinceRef.current = ts; // this device began the show → it is the controller as of now
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
        audio.play().catch((err) => onPlayRejected(cur.id, err));
        setAudioPlaying(true);
      }
    } else {
      // switching to Manual — stop any pending overlap pre-roll on the secondary
      if (mode === "manual") {
        audioRef2.current?.pause();
        overlapNextIdRef.current = null;
        preRollIdRef.current = null;
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
      // The pre-roll only claims the id once its play() resolved, but the element
      // can still have been stopped since (an interruption, a route change). Promote
      // only something that is genuinely sounding — otherwise fall through to the
      // ordinary branch below, which hard-cuts on the element we know works.
      if (it && overlapNextIdRef.current === it.id && audioRef2.current?.paused) {
        overlapNextIdRef.current = null;
      }
      // …and whenever we are NOT promoting — a refused pre-roll, or the operator
      // tapping some other row — the secondary may still be sounding the track it
      // pre-rolled. The ordinary branch below starts a track on the PRIMARY, so
      // leaving it running puts two songs out of the PA at once. Silence it first.
      if (!it || overlapNextIdRef.current !== it.id) {
        if (preRollIdRef.current) {
          audioRef2.current?.pause();
          preRollIdRef.current = null;
          overlapNextIdRef.current = null;
        }
      }
      if (it && overlapNextIdRef.current === it.id) {
        const lead = -(it.buffer_before_seconds ?? 0);
        swapAudio();
        endedItemRef.current = null;
        setPlayingId(it.id);
        setAudioPlaying(true);
        overlapNextIdRef.current = null;
        preRollIdRef.current = null; // it is the primary now, not a pre-roll
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
      if (it) {
        const url = audioUrls[it.id];
        const a = audioRef.current;
        // crossfade (opt-in): fade the sounding track out instead of hard-cutting
        if (crossfade && url && a && !a.paused && playingId !== it.id) {
          crossfadeSwap(it.id, url);
        } else {
          playItemAudio(it.id);
        }
      }
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
    preRollIdRef.current = null;
    autoTriggeredForRef.current = null;
    autoAdvanceForRef.current = null;
    endedItemRef.current = null;
    setPlayingId(null);
    setAudioPlaying(false);
    setAudioCurrent(0);
    setAudioDuration(0);
    markShowEnded(false); // a reset show is a fresh one — it may be run again
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
      <LiveStatusStrip eventId={eventId} isController={isController} soundOutput={soundOutput} />

      {/* Audio needs a tap to (re)start — after a reload / autoplay block. Big target. */}
      {needsAudioResume && (
        <button
          onClick={resumeAudio}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400 bg-amber-500 px-4 py-3 text-base font-bold text-black shadow-sm animate-pulse hover:bg-amber-400"
        >
          <Volume2 className="h-5 w-5" /> แตะเพื่อเล่นเสียงต่อ (ตำแหน่งปัจจุบัน)
        </button>
      )}

      {/* A real playback failure on this device — the countdown keeps running, so
          say WHY the PA is silent instead of leaving the operator guessing. */}
      {audioFault && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-400 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-800 dark:text-rose-300">
          <span className="flex min-w-0 items-center gap-1.5">
            <VolumeX className="h-4 w-4 shrink-0" />
            <span className="min-w-0">
              เล่นไฟล์เสียงไม่สำเร็จ: “{audioFault.title}” — เครื่องนี้ไม่มีเสียง (โชว์ยังเดินต่อ) · ลองโหลดไฟล์เพลงใหม่
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              audioFaultRef.current = null;
              setAudioFault(null);
            }}
            title="ปิดข้อความนี้"
            className="shrink-0 rounded-md px-2 py-0.5 text-xs underline-offset-2 hover:underline"
          >
            ปิด
          </button>
        </div>
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
        {/* The crew's cue text for the item that's ON NOW (โปรย confetti / เปลี่ยนชุด /
            สคริปต์ MC). It used to live ONLY on the next-up prep card, so it vanished
            the instant the item became current — exactly when the cue is due — and that
            card is landscape-only. Capped + scrollable (never truncated) so a long MC
            script can't push the countdown off a phone screen. */}
        {current?.notes && (
          <p className="mt-3 max-h-24 overflow-y-auto break-words rounded-lg bg-black/10 px-3 py-2 text-left text-sm">
            📝 {current.notes}
          </p>
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
                {/* iOS hands back a READ-ONLY HTMLMediaElement.volume: the assignment
                    is accepted and does nothing, so this slider, the 3-second Auto
                    Mute fade and the MC duck all animate convincingly while the PA
                    stays at full level. Only says so on the device that is actually
                    the sound host — if the speakers hang off a laptop or the desktop
                    app, an iPad operator's slider works fine (the level is broadcast
                    and applied over there). */}
                {volumeIsDead && soundOutput && (
                  <p className="text-[11px] leading-snug text-amber-200">
                    เครื่องนี้ (iPhone/iPad) ปรับ “ระดับเสียง” ในแอปไม่ได้ — สไลเดอร์กับปุ่มหรี่เสียงจะไม่มีผลจริง
                    ใช้ปุ่มเพิ่ม/ลดเสียงข้างเครื่อง หรือให้เครื่องอื่นเป็นตัวปล่อยเสียงแทน (ปุ่มปิดเสียงยังใช้ได้)
                  </p>
                )}

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
          {/* …and its cue text with it: the prep card that carries 📝 is landscape-only,
              so on a phone held UPRIGHT — how an operator actually holds it — the note
              the band typed had nowhere at all to appear. Same cap-and-scroll rule as
              the countdown card: compact, but the full text stays reachable. */}
          {next?.notes && (
            <p className="mt-1.5 max-h-16 overflow-y-auto break-words rounded-lg bg-muted/60 px-2 py-1 text-left text-xs">
              📝 {next.notes}
            </p>
          )}
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
            {/* เครื่องเสียงคุมคนเดียว: only a sound-output device may take control.
                A muted viewer sees no take-control button — turn on "เสียงออก" below
                to become the show device (audio + control move here together). */}
            {soundOutput && (
              <Button
                size="sm"
                variant="outline"
                onClick={takeControl}
                className="shrink-0 border-amber-400 bg-white"
              >
                ขอควบคุม
              </Button>
            )}
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

        {/* per-device playback options: crossfade (opt-in) + output routing
            (desktop-only picker). Defaults keep the old behavior exactly. */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const next = !crossfade;
              setCrossfade(next);
              try {
                localStorage.setItem("cueiq:crossfade", next ? "1" : "0");
              } catch {
                /* ignore */
              }
            }}
            title={
              crossfade
                ? "Crossfade เปิด — ตอนเปลี่ยนเพลง เพลงเดิมจะเฟดออก ~2 วิ (แตะเพื่อปิด)"
                : "Crossfade ปิด — เปลี่ยนเพลงแบบตัดทันที (แตะเพื่อเปิดเฟดไขว้)"
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
          <Button
            size="xl"
            className="w-full"
            onClick={start}
            disabled={!isController || !syncSettled}
            title={!syncSettled ? "กำลังซิงค์สถานะโชว์กับเครื่องอื่น…" : undefined}
          >
            {syncSettled ? (
              <>
                <Play className="h-5 w-5" /> START SHOW
              </>
            ) : (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> กำลังซิงค์สถานะโชว์…
              </>
            )}
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
