"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
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
  HardDriveDownload,
  ArrowLeft,
  Wifi,
  WifiOff,
  Ellipsis,
  Lightbulb,
  Check,
  Mic,
  GraduationCap,
  X,
  Maximize,
  SlidersHorizontal,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { shouldMuteOnStepDown, shouldYieldControl } from "@/lib/live-arbitration";
import { saveAudio, loadAudioForEvent, deleteAudio } from "@/lib/audio-store";
import { heldFileIsAnotherSongs } from "@/lib/audio-targets";
import { getCachedSongBlob, cacheSongBlob } from "@/lib/song-cache";
import { getLocalSource, listLocalSourceIds } from "@/lib/local-source";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import { persistLastRun } from "@/lib/show-run-outbox";
import { setLiveShowActive } from "@/lib/live-guard";
import { getDeviceId, deviceLabel } from "@/lib/device-id";
import {
  claimAuthority,
  getAuthority,
  heartbeatAuthority,
  isGhost,
  releaseAuthority,
  type AuthorityRow,
} from "@/lib/show-authority";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import {
  buildSongAudioPath,
  uploadEventAudio,
  downloadEventAudio,
  removeEventAudio,
} from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { LiveStatusStrip } from "@/components/event/live-status-strip";
import { AudioOutputPicker, AUDIO_SINK_KEY, loadAudioSink } from "@/components/event/audio-output-picker";
import { NowCard } from "@/components/live/now-card";
import { useSongCovers } from "@/lib/song-covers";
import { KindChip, KindTile } from "@/components/event/kind";
import { MicGrid } from "@/components/event/mic-grid";
import { RunMeter } from "@/components/event/run-meter";
import { OfflineBanner } from "@/components/offline-banner";
import { StageLight } from "@/components/stage-light";
import { useFullscreen } from "@/components/kiosk-mode";
import { FeedbackButton } from "@/components/feedback-button";
import { ThemeSeg } from "@/components/account-panel";
import { cn } from "@/lib/utils";
import { liveTopic, privateChannel, songsTopic } from "@/lib/realtime";
import {
  SETLIST_KIND_SHORT,
  type SetlistItem,
  type SetlistKind,
} from "@/lib/types";
import { formatDuration, nowClock, pad2 } from "@/lib/time";
import { liveZone } from "@/lib/live-zone";

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

/** What a non-admin may and may not do here — the โหมดซ้อม chip's title and the
 *  first line of Live tools. */
const REHEARSAL_NOTE =
  "โหมดซ้อม — เล่น/รันเพื่อซ้อมจับเวลาได้ แต่ปรับลำดับ/เปลี่ยนไฟล์/บันทึก “จบโชว์” สงวนไว้สำหรับแอดมิน";

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Live tools is aria-modal but not a Radix dialog, so it keeps Tab in by hand: from
 *  its last control Tab wraps to the first, and Shift+Tab from the first (or from the
 *  panel itself) to the last. Without it Shift+Tab from ปิด landed on the dock key
 *  under the scrim — START, or Run/Pause mid-show — and the next Space pressed it.
 *  Every other Tab is left to the browser. "Shown" is read from computed style, so a
 *  control a breakpoint hides (the landscape-phone fade keys) is never a wrap target. */
function wrapTabInside(e: React.KeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  const shown = (el: HTMLElement) => {
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (let n: HTMLElement | null = el; n && n !== panel; n = n.parentElement) {
      if (n.hidden || getComputedStyle(n).display === "none") return false;
    }
    return true;
  };
  const tabbables = Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]'
    )
  ).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && shown(el));
  const active = document.activeElement;
  if (tabbables.length === 0) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (e.shiftKey ? active === first || active === panel : active === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
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
  userId,
  tenantId,
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
  /** Who is reporting, for the Feedback form in Live tools (this screen has no
   *  app header and no floating button). Without both, the form is not offered. */
  userId?: string | null;
  tenantId?: string | null;
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
  // Set just before an ARBITRATION mute so the persist effect below can tell a
  // verdict apart from the operator flipping the switch. Cleared as it is read.
  const mutedByStepDownRef = useRef(false);
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

  // Live tools sheet (presentation only): open/closed + where focus goes.
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);
  const toolsCloseRef = useRef<HTMLButtonElement>(null);
  // Stage running order (presentation only): the admin's row keys show in edit mode
  // only. Read by CSS through `data-edit`, so the memoized rows never re-render for it.
  const [orderEdit, setOrderEdit] = useState(false);

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
          // Come back as the ROLE this device had, not as a fresh default.
          // Viewers write snapshots too (any device in a running show does), and
          // restoring one used to hand every reloaded phone `isController = true`
          // with a null claim — so a band member whose screen had slept woke up as
          // a second controller and, on the next tick, broadcast its own stale
          // auto-advance over the PA's track. Restoring the claim as well makes the
          // arbitration deterministic afterwards instead of a coin flip.
          if (snap.isController === false) {
            isControllerRef.current = false;
            setIsController(false);
          }
          if (typeof snap.controllerSince === "number") {
            controllerSinceRef.current = snap.controllerSince;
          }
          // Restore "the show already ended" too. จบโชว์ leaves begun:true, so a
          // device that reloads afterwards used to come back believing the show
          // was still on — and since `ended` now travels between devices, it
          // would answer the next sync-request with fromController:true,
          // ended:false and re-light the wake lock on every phone that had
          // already gone to sleep, with no controller left to correct it.
          if (snap.ended) markShowEnded(true);
          toast.message("กู้คืนสถานะโชว์ที่ค้างไว้", {
            description: "เวลาเดินต่อจากเดิม — กดรีเซ็ตถ้าจะเริ่มใหม่",
          });
        }
      }
    } catch {}
    liveRestoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // The single writer for the crash-recovery snapshot — shared by the debounce
  // below, the flush-on-hide under it, and จบโชว์ itself, so the copies of this
  // write can never drift apart.
  //
  // `s` is passed explicitly by a caller that has just COMPUTED the next state:
  // stateRef is only reassigned during the next render, so a flush inside the same
  // tick that ends a running show would otherwise write `running: true` back to
  // disk. (The desktop port, desktop/src/pages/my-show.tsx, takes it the same way.)
  function writeLiveSnapshot(s: LiveState = stateRef.current) {
    if (!liveRestoredRef.current) return; // don't write before the restore check ran
    try {
      if (s.begun) {
        localStorage.setItem(
          `cueiq:live:${eventId}`,
          JSON.stringify({
            state: s,
            committed: committedRef.current,
            // Not part of LiveState (it is per-device, never applied), but it has
            // to survive a reload or the restored device tells everyone else the
            // show is back on — see the restore above.
            ended: showEndedRef.current,
            // Per-device too, and for the same reason: a reload must not promote a
            // viewer to controller (see the restore).
            isController: isControllerRef.current,
            controllerSince: controllerSinceRef.current,
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
    // `showEnded` is NOT a dep (it is declared far below, so naming it here is a
    // TDZ error) and it doesn't need to be: writeLiveSnapshot reads the flag off
    // its ref, so every path that flips it ALSO changes LiveState and re-runs
    // this. The one exception is จบโชว์ — which flushes by hand from BOTH of its
    // branches (endShow()), since this debounce is also the half-second the
    // operator can outrun by navigating off the page.
    //
    // `isController` IS a dep: the snapshot now carries the device's role, and a
    // step-down that arrives without any state change would otherwise leave a
    // snapshot on disk still claiming this device drives the show.
  }, [state, isController, eventId]);

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
    // Persist the OPERATOR'S choice only. Stepping down to a viewer also mutes
    // this device (เครื่องเสียงคุมคนเดียว) — but that is an arbitration verdict
    // about one moment, not a preference, and writing it here made it outlive the
    // show: a tablet that once joined a running show came back as the PA at the
    // NEXT gig with sound off, showing a green "เสียงพร้อมครบ" while the room
    // stayed silent. A verdict is remembered for this page, never for the device.
    if (mutedByStepDownRef.current) {
      mutedByStepDownRef.current = false;
      return;
    }
    try {
      localStorage.setItem("cueiq:soundOutput", soundOutput ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [soundOutput]);

  // Lock the SOUND device into Live Mode while a show is live: leaving would cut the
  // audio. Block in-app navigation (back / header nav / logo) + warn on refresh/close.
  // To leave, turn off "เสียงออกเครื่องนี้" first (then edit on a remote with sound off).
  //
  // The CONTROLLER is guarded too, sound or no sound. Driving a show from a muted
  // phone while the PA plays the file is a supported setup (see the remote-control
  // help text below), and on that phone none of this was armed: one stray tap on
  // the logo navigated away instantly, and because auto-advance is controller-only,
  // the running track finished and the show simply stopped with nobody driving it.
  useEffect(() => {
    if (!(state.begun && (soundOutput || isController))) return;
    // Tell out-of-tree actions (the header Sign-out button) that a sounding show is
    // live here, so they confirm before cutting it — the click/beforeunload guards
    // below can't see a programmatic sign-out navigation.
    setLiveShowActive(true);
    // Electron replaces the browser's leave-confirm with its own dialog; say which
    // guard this is so it does not describe an unsaved edit (see main.cjs).
    window.cueiqNative?.setUnloadReason("show").catch(() => {});
    const livePath = `/events/${eventId}/live`;
    // Say what THIS device actually loses by leaving — a muted controller's audio
    // is not what stops, the show is.
    const leaveWarning = soundOutput
      ? "ออกจาก Live Mode ตอนนี้? เสียงที่กำลังเล่นบนเครื่องนี้จะหยุด"
      : "เครื่องนี้กำลังคุมโชว์อยู่ — ออกแล้วจะไม่มีเครื่องคุมโชว์ ออกเลยไหม?";
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
        if (window.confirm(leaveWarning)) {
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
      window.cueiqNative?.setUnloadReason(null).catch(() => {});
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [soundOutput, isController, state.begun, eventId]);

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
          // A row swapped to another song since this device cached it: these bytes
          // are, by the library's own record, the OLD song's (lib/audio-targets.ts).
          // Never restore them — with no master for the new song yet, nothing would
          // ever replace them and the old song would play under the new title.
          const row = itemsRef.current.find((x) => x.id === s.itemId);
          if (row && heldFileIsAnotherSongs(s.path, row.song_id, songAudioRef.current)) {
            deleteAudio(eventId, s.itemId).catch(() => {});
            continue;
          }
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
  /** Forget the bytes this device holds for one row: the object URL, the state the
   *  row's indicator and playback read, which version they were, and the per-event
   *  IndexedDB copy the next open would restore. */
  function dropHeldAudio(id: string) {
    const url = audioUrlsRef.current[id];
    if (url) URL.revokeObjectURL(url);
    delete cachedPathRef.current[id];
    const without = <T,>(prev: Record<string, T>) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    };
    setAudioUrls(without);
    setAudioNames(without);
    deleteAudio(eventId, id).catch(() => {});
  }

  function audioVersionOf(it: { song_id?: string | null; audio_path?: string | null }) {
    if (it.audio_path) return it.audio_path;
    if (it.song_id && localSongIdsRef.current.has(it.song_id)) return `local:${it.song_id}`;
    return null;
  }

  // Rows the on-air lock skipped, and the counter that asks the download effect to
  // look at them again once the track they belong to is no longer sounding.
  const deferredOnAirRef = useRef<Set<string>>(new Set());
  const [onAirRetry, setOnAirRetry] = useState(0);

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
        // The row's song was swapped while this screen was open (setlist-changed
        // refetch) and the bytes held here are the old song's — drop them, whether
        // or not the new song has a file to fetch. Not while they are sounding: the
        // on-air lock below defers it, and the retry comes back here.
        if (
          audioUrlsRef.current[it.id] &&
          heldFileIsAnotherSongs(cachedPathRef.current[it.id], it.song_id, songAudioRef.current)
        ) {
          if (it.id === playingIdRef.current) {
            deferredOnAirRef.current.add(it.id);
            continue;
          }
          dropHeldAudio(it.id);
        }
        if (!version) continue;
        // LOCK the on-air file: never re-download or revoke the track that's
        // currently sounding (a mid-show library re-upload won't cut the live song).
        // Remember what the lock deferred: the signature already changed to the new
        // file, so without this the row is skipped for the rest of the session and a
        // repeat/encore of that song plays the REPLACED master with every indicator
        // green. The effect below re-runs this loop once the track leaves the air.
        if (it.id === playingIdRef.current && audioUrlsRef.current[it.id]) {
          // Only a row that actually wants DIFFERENT bytes is deferred. Recording
          // every sounding row here made the signature's other triggers — a
          // reorder, an unrelated upload — leave a member behind, so the next
          // track change bumped the retry and re-ran the whole loop for nothing,
          // which on venue wifi means restarting an in-flight master download.
          if (cachedPathRef.current[it.id] !== version) {
            deferredOnAirRef.current.add(it.id);
          }
          continue;
        }
        deferredOnAirRef.current.delete(it.id);
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
          /* 🔄 The source ladder used to be one chained `??` expression. It is spelled out
             now for ONE reason: the caller has to know whether these bytes came off the
             NETWORK, because only then are they news to the shared library cache.
             Live Mode READ that cache (getCachedSongBlob) and never wrote it, so every
             master it pulled was known to this event and to nothing else — open the same
             band's next event and all of it downloads again, 27–88 MB a song, on venue
             wifi. `saveAudio()` below is the PER-EVENT store; `cacheSongBlob()` is the
             per-SONG one the library prefetch and the practice player share. Both are
             wanted, and only the second one was missing. */
          let blob: Blob;
          let fromNetwork = false;
          if (!path) {
            blob = local!.blob;
          } else if (local?.blob) {
            blob = local.blob;
          } else {
            const cached = await getCachedSongBlob(path);
            if (cached) {
              blob = cached;
            } else {
              blob = await downloadEventAudio(path);
              fromNetwork = true;
            }
          }
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
          /* …and tell the SHARED library cache too, but only about bytes that BELONG in it:
             · `fromNetwork` — a cache hit is already filed, and a per-device local override
               has no `path` to file it under (that null is how audio-store marks "the only
               copy that exists", and the orphan sweep depends on it);
             · `it.song_id` — and this one is not obvious. An unlinked LEGACY setlist item
               keeps its own `audio_path` under `<tenant>/<group>/<event>/<item>-…`, which is
               not a song key at all. Nothing ever reads the library cache by it (Practice and
               คลังเพลง look up `song.audio_path`), and `songIdFromPath` parses the SETLIST
               ITEM's uuid out of it, which never appears in `currentBySong` — so
               `pruneSupersededSongs` deliberately KEEPS it, forever. Three legacy jingles at
               30–80 MB each would leave ~150 MB of unreachable, unsweepable bytes on the venue
               laptop after every show, in the same IndexedDB budget whose exhaustion costs
               that laptop its queued offline edits.
             Best-effort by design — a full quota must never take the show down. */
          if (fromNetwork && path && it.song_id) cacheSongBlob(path, blob, name).catch(() => {});
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
  }, [audioSig, eventId, localsRead, onAirRetry]);

  // A row whose new file the on-air lock deferred is stuck: its signature already
  // changed, so nothing re-triggers the download. Once that row stops being the
  // sounding one, ask for the loop again — this is the only path that picks up a
  // master replaced while its own song was playing.
  useEffect(() => {
    if (deferredOnAirRef.current.size === 0) return;
    if (playingId && deferredOnAirRef.current.has(playingId)) return; // still on air
    setOnAirRetry((n) => n + 1);
  }, [playingId]);

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
      // Under Electron the screen lock is not enough: Windows' own power plan can
      // still sleep the machine during a long silent stretch (MC talk, set change)
      // on the very desktop that is running the show. Web builds have no bridge
      // and simply skip this.
      window.cueiqNative?.setShowRunning(false).catch(() => {});
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
    window.cueiqNative?.setShowRunning(true).catch(() => {});
    return () => {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      window.cueiqNative?.setShowRunning(false).catch(() => {});
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
          // A RUNNING show outranks the id coin-flip. Without this, a phone that
          // had merely opened the page could win the tie against a PA that had
          // reloaded mid-show, re-assert its own empty INITIAL state as the
          // authority, and stop the music. See lib/live-arbitration.ts.
          mineBegun: stateRef.current.begun,
          theirsBegun: !!payload.begun,
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
          // A verdict, not a preference — don't let it be written to disk.
          mutedByStepDownRef.current = true;
          setSoundOutput(false);
        }
      }
      // Picking up a show that was already running, with no claim of our own, makes
      // this device a VIEWER — even when the state came from another viewer's
      // sync-reply, which is the one path into here that never runs the arbitration
      // above. Without this a device that merely opened the page adopted `begun` and
      // kept its default isController=true, becoming a second controller nobody
      // elected; from there its own auto-advance ticks go out over the PA's track.
      const adoptingRunningShow =
        !stateRef.current.begun && (payload.begun ?? payload.startedAt != null);
      if (adoptingRunningShow && controllerSinceRef.current === null) {
        isControllerRef.current = false;
        setIsController(false);
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
        // ...and re-read the SETLIST, which the sync-request does not carry. A
        // broadcast reaches only whoever is joined at that instant, so every
        // 'setlist-changed' sent during a blip is gone for good — and the device
        // that stays VISIBLE through a blip is precisely the PA desktop at the
        // venue, whose visibilitychange refetch therefore never fires. It then
        // runs the rest of the show on a stale order while looking perfectly
        // healthy. refetch defers against in-flight writes and the download effect
        // locks the on-air track, so this is safe mid-show — the same reasoning
        // the visibilitychange refetch already relies on.
        refetchRef.current();
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
    // Reconnecting asks for the show state AND re-reads the setlist, for the same
    // reason as the SUBSCRIBED handler: a device that never went hidden has no
    // other trigger to heal the broadcasts it missed while the network was down.
    const onOnline = () => {
      ask();
      refetchRef.current();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onOnline);
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
  // itemId → sort_order for a reorder made with NO network, i.e. an order that
  // exists only here. Server rows are older than it until the replay below lands,
  // so every refetch lays it back on top; cleared the moment a reorder is acked.
  const pendingOrderRef = useRef<Record<string, number> | null>(null);
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
    let newItems = (itemsRes.data as SetlistItem[]).map((it) =>
      resolveItemAudio(it, songAudioRef.current)
    );
    // A reorder this device made offline has not reached the server, so these rows
    // carry the order it replaced. Re-apply it rather than reverting the running
    // show to an order the operator already moved away from.
    const pend = pendingOrderRef.current;
    if (pend) {
      newItems = newItems
        .map((it) => (pend[it.id] != null ? { ...it, sort_order: pend[it.id] } : it))
        .sort((a, b) => a.sort_order - b.sort_order);
    }
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

  // Send an offline reorder once the network is back — the toast told the operator
  // the other devices would catch up "จนกว่าเน็ตจะกลับ", and nothing used to make
  // that true: the failed writes were never retried, so the venue ran the rest of
  // the show with this device on one order and everyone else on another.
  // ⚠️ THERE IS DELIBERATELY NO BACKGROUND REPLAY OF AN OFFLINE REORDER.
  //
  // One was written and taken back out. Retrying those sort_order writes on the
  // 'online' event lands them in the one minute supabase-js sends the anon key,
  // so they came back 0-row-no-error and the order parked forever with nothing
  // left to re-fire it; adding a timer to fix that put an UNBOUNDED write on a
  // repeating schedule, and at a venue "associated to the AP with no route out"
  // that write never settles — pinning writesInFlight and killing every setlist
  // refetch for the rest of the show. A mid-show reorder is rare; a Live Mode
  // that stops seeing the setlist is not survivable.
  //
  // What IS kept is the part that matters: pendingOrderRef holds the order this
  // device is running on so no refetch can revert it mid-show, and the next
  // reorder made WITH a network writes the whole order out (see moveItem /
  // reorderTo) and clears it. The toast says exactly that, so nothing is
  // promised that this code does not do.

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
  // The offline-reorder replay is registered once, so it reaches this through a ref.
  const bcastSetlistChangedRef = useRef(bcastSetlistChanged);
  bcastSetlistChangedRef.current = bcastSetlistChanged;

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
    // Normally a swap writes only its two rows. But while an offline order is
    // still held, those two rows are the only ones the server would learn about
    // and the rest of that order would stay invisible forever — so once there is
    // a network again, the first reorder writes the WHOLE order out and hands the
    // venue a single consistent list.
    const covering = !!pendingOrderRef.current;
    const res = await (covering
      ? writeFullOrder(supabase, reordered)
      : Promise.all([
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
        ])
    ).finally(() => {
      // clear the gate even if the round-trip threw, or refetches stay deferred
      writesInFlightRef.current--;
    });
    if (!reorderLanded(res, reordered, covering)) return;
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
    results: { error: { message: string } | null; data: unknown[] | null }[],
    ordered?: SetlistItem[],
    // True when this write was writeFullOrder, i.e. it sent EVERY current row.
    // Passed explicitly rather than inferred from the ids, because a held order
    // can name a song that has since been removed from the setlist — that id can
    // never appear in a later write, so an id-membership test would be
    // permanently unsatisfiable and the stale order would be stamped back over
    // every refetch for the rest of the show.
    covering = false
  ): boolean {
    const err = results.find((r) => r.error)?.error;
    const missed = results.some((r) => !r.error && (r.data?.length ?? 0) === 0);
    if (!err && !missed) {
      // A plain ▲/▼ writes only its two rows, so it must NOT clear a held offline
      // order — the rest of that order is still unknown to the server, and the
      // next refetch would put the old one back mid-show. Only a covering write
      // (or having nothing held) settles it.
      if (covering || !pendingOrderRef.current) pendingOrderRef.current = null;
      return true;
    }
    if (err && isOffline()) {
      // Hold the order this device is running on, so the next refetch cannot
      // quietly put the old one back mid-show — a reconnect used to do exactly
      // that, and in Auto the show then advanced to a different song than the one
      // on screen.
      if (ordered) {
        pendingOrderRef.current = Object.fromEntries(
          ordered.map((it) => [it.id, it.sort_order])
        );
      }
      toast.warning("ออฟไลน์ — สลับลำดับแล้วเฉพาะเครื่องนี้", {
        description:
          "โชว์เดินตามลำดับใหม่ที่นี่ เครื่องอื่นยังเห็นลำดับเดิม — สลับอีกครั้งตอนเน็ตกลับมาเพื่อส่งลำดับนี้ให้ทุกเครื่อง",
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

  /** Write every row's sort_order — used when an offline order is still held, so
   *  one covering write replaces it everywhere instead of leaking two rows of it. */
  function writeFullOrder(
    supabase: ReturnType<typeof createClient>,
    ordered: SetlistItem[]
  ) {
    return Promise.all(
      ordered.map((it) =>
        supabase
          .from("setlist_items")
          .update({ sort_order: it.sort_order })
          .eq("id", it.id)
          .select("id")
      )
    );
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
    // ⏹ SILENCE THIS DEVICE — running or not. The pause used to live inside the
    // `s.running` branch below, which is exactly the state จบโชว์ is LEAST often
    // pressed from: Manual deliberately leaves the previously-committed track
    // sounding while the next row is cued (goto's manual branch sets running:false
    // and touches no audio at all). So START → NEXT → จบโชว์ recorded the run,
    // released every wake lock and told Electron the show was over while the song
    // played on out of the PA, with nothing left on screen that would stop it.
    audioRef.current?.pause();
    audioRef2.current?.pause();
    overlapNextIdRef.current = null;
    preRollIdRef.current = null;
    setAudioPlaying(false);
    // Telling the OTHER devices needs no new message: every state broadcast
    // already carries this device's audio intent (audioFields), and that intent is
    // read off committedRef — which in the Manual-cue case still names the track we
    // just silenced, i.e. would tell a speaker device to keep playing it. Clearing
    // it here, before both branches broadcast, is what makes "the show is over"
    // mean the same thing on the PA as it does here.
    committedRef.current = { id: null, anchor: null };
    // freeze the accumulated clock (does NOT reset the show)
    if (s.running) {
      const frozenItem = s.itemStartedAt
        ? (Date.now() - s.itemStartedAt) / 1000
        : (s.itemElapsedAtPause ?? 0);
      const next = { ...s, running: false, itemElapsedAtPause: frozenItem };
      apply(next);
      // Flush by hand as well, for the same reason the paused branch below does
      // (and as the desktop port's endShow() already did): the snapshot effect is
      // debounced 500 ms and its cleanup clearTimeout()s on unmount, and a Next
      // client-side navigation off this page fires NO pagehide — so leaving inside
      // that window left a snapshot on disk still saying running:true, and the next
      // open of the event restored a finished show as a live one (wake lock
      // re-armed, other devices told the show was back on). `next`, not stateRef:
      // the ref is only reassigned during the next render, so it still holds the
      // running state here.
      writeLiveSnapshotRef.current(next);
    } else {
      // Ending an already-paused show changes no LiveState, so neither the
      // broadcast nor the snapshot would happen on their own — and without the
      // snapshot this device forgets the show ended the moment it reloads.
      writeLiveSnapshotRef.current();
      if (isControllerRef.current) {
        channelRef.current?.send({
          type: "broadcast",
          event: "state",
          payload: statePayload(s),
        });
      }
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
    // The delta filter compares against the LOCAL list, which while an offline
    // order is held is not what the server has — so the rows it skips are exactly
    // the ones the server still needs. Write the whole order in that case (see
    // writeFullOrder).
    const covering = !!pendingOrderRef.current;
    const res = await (covering
      ? writeFullOrder(supabase, renumbered)
      : Promise.all(
          renumbered
            .filter((it) => orig.find((o) => o.id === it.id)?.sort_order !== it.sort_order)
            .map((it) =>
              supabase
                .from("setlist_items")
                .update({ sort_order: it.sort_order })
                .eq("id", it.id)
                .select("id")
            )
        )
    ).finally(() => {
      // clear the gate even if the round-trip threw, or refetches stay deferred
      writesInFlightRef.current--;
    });
    if (!reorderLanded(res, renumbered, covering)) return;
    bcastSetlistChanged();
    // a refetch landed while we were writing — pull it now that we're settled
    if (missedRefetchRef.current) refetchRef.current();
  }

  // Pick a file in Live Mode = the QUICK/ad-hoc path (you forgot to prep in the
  // library). Plays instantly on this device, then uploads to R2 as a TEMPORARY
  // library song (removable later, never on a timer — see the note by `expires` below)
  // and LINKS this item to it — so all
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
      /* Create a TEMPORARY library song + link the item.
         ⚠️ `audio_expires_at` is a STAMP, not a deadline any more. Round 10 removed the
         sweep that deleted on this date alone — it ran off the device clock, measured three
         days from UPLOAD rather than from the show, and destroyed the R2 master with no
         confirmation, so a song uploaded at a Tuesday rehearsal for a Sunday gig was gone by
         Friday. Nothing is removed now unless a server-supplied clock says it is past, no
         un-finished event still links it, AND a human confirms (lib/temp-song-purge.ts).
         Keep the stamp; do not reinstate a countdown anywhere from it. */
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
      // This is the one write in the function whose result was never looked at —
      // not even for an error. The bytes are already on R2 by now and a long WAV
      // upload is exactly how a token expires mid-flight, so a 0-row anon write
      // here leaves the library song with audio_path NULL while THIS device plays
      // happily from its own object URL: the PA on another machine finds no audio
      // and the row is silent at showtime.
      const { data: pathRows, error: pathErr } = await supabase
        .from("songs")
        .update({ audio_path: path, audio_name: file.name })
        .eq("id", songId)
        .select("id");
      if (pathErr) throw pathErr;
      if (wroteNothing(pathRows)) throw new Error(await noRowsMessage());
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
      /* 🔤 The old copy promised "(3 วัน)", which stopped being true when the blind expiry
         sweep was removed — and it was the one line that told the user a number. Say what
         actually decides now, and where the escape hatch is. */
      toast.success(
        "อัปขึ้นคลังเป็นเพลงชั่วคราว — จะถูกลบก็ต่อเมื่อไม่มีงานที่ยังไม่จบใช้อยู่ และมีคนกดยืนยันเท่านั้น · กดรูปกุญแจในคลังเพลงเพื่อเก็บถาวร"
      );
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
  // The NOW card's cover: the setlist's songs' covers, read once (lib/song-covers.ts —
  // the event bundle carries none). Decoration: offline, or not yet read, means none.
  const songCovers = useSongCovers(useMemo(() => items.map((it) => it.song_id), [items]));
  const currentCover = current?.song_id ? songCovers[current.song_id] ?? null : null;

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

  // Warning ladder (lib/live-zone): warn/urgent scale to the item's own block.
  const zoneBlock = current ? blockSeconds(current) : 0;
  const zone = liveZone({ running: state.running, remaining, blockSec: zoneBlock });
  // The zone's look is components/live/now-card.tsx + app/stage.css (.zone-warn /
  // .zone-urgent / .alarm-plate), on tokens no band skin writes.

  // ── display-only figures (O(n) arithmetic per 500 ms tick; nothing here is state) ──
  const futureSec = items.slice(state.currentIndex + 1).reduce((s, it) => s + blockSeconds(it), 0);
  const plannedBefore = items.slice(0, state.currentIndex).reduce((s, it) => s + blockSeconds(it), 0);
  const plannedTotal = plannedBefore + zoneBlock + futureSec;
  // What is left of the PLAN from here: this item's remaining time plus every block
  // after it. (The slot / Hard Out version needs the show's times — not passed here.)
  const showRemaining = Math.max(0, remaining) + futureSec;
  const projectedEnd = nowClock(new Date(now + showRemaining * 1000)).slice(0, 5);
  const itemEndClock = nowClock(new Date(now + Math.max(0, remaining) * 1000));
  // the dock strip's playhead: where the show is in its PLAN, not wall-clock time
  const playheadSec = Math.min(plannedTotal, plannedBefore + Math.min(Math.max(0, elapsedItem), zoneBlock));
  const runBlocks = items.map((it) => ({ kind: it.kind as SetlistKind, seconds: blockSeconds(it) }));
  const audioItems = items.filter((it) => it.audio_path);
  const readyCount = audioItems.filter((it) => audioUrls[it.id]).length;
  const allReady = readyCount === audioItems.length;
  const downloadingAudio = audioItems.some((it) => audioBusy[it.id] === "down");
  const readinessSentence = allReady
    ? `เสียงพร้อมครบ ${audioItems.length} เพลง — เล่นได้แม้เน็ตหลุด`
    : downloadingAudio
      ? `กำลังโหลดเสียงลงเครื่อง ${readyCount}/${audioItems.length}…`
      : `เสียงในเครื่องนี้ ${readyCount}/${audioItems.length} — อีก ${audioItems.length - readyCount} เพลงจะดึงจากเน็ตตอนเล่น`;
  const syncLabel = syncReady
    ? "ซิงค์แล้ว"
    : isOffline()
      ? "ออฟไลน์ · โชว์เดินต่อ"
      : syncStatus === "init"
        ? "กำลังเชื่อม…"
        : syncStatus;
  // ONE lock for NEXT's `disabled` AND its overtime invite ring, so the ring can never
  // pulse on a key that cannot be pressed (the last item, a viewer, Auto).
  const nextLocked = !isController || state.mode === "auto" || state.currentIndex >= items.length - 1;
  // An offline cached row can lack `kind`: no "(undefined)" under START.
  const firstKind = items[0]?.kind ? SETLIST_KIND_SHORT[items[0].kind as SetlistKind] : undefined;
  // Live tools: focus moves into the sheet when it opens and back to ⋯ when it
  // closes (so Escape, handled on the sheet, reaches it). flushSync un-hides the
  // sheet before the focus call; neither touches the show.
  const openTools = () => {
    flushSync(() => setToolsOpen(true));
    toolsCloseRef.current?.focus();
  };
  const closeTools = () => {
    setToolsOpen(false);
    toolsBtnRef.current?.focus();
  };
  // The sheet is aria-modal, so the page under it must not move: a wheel or a drag
  // on its scrim used to scroll the document and leave NOW's timer off-screen after
  // the sheet closed. Open: freeze the document's scroll (and remember where it
  // was); close: put both back. Presentation only — nothing here reads or writes
  // the show, the audio or the sync.
  useEffect(() => {
    if (!toolsOpen) return;
    const root = document.documentElement;
    const y = window.scrollY;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      // a no-op unless something moved the page while it was frozen (iOS ignores overflow)
      // — and only while Live is still on screen. This cleanup also runs when Live
      // UNMOUNTS with the sheet open (a route change, the back arrow): the page that
      // opens next is a new page, and handing it Live's scroll position opened it
      // scrolled down. The ⋯ button is the witness, read NOW and not when the effect
      // started: by then React has cleared its ref and taken it out of the document.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (toolsBtnRef.current?.isConnected && window.scrollY !== y) window.scrollTo(0, y);
    };
  }, [toolsOpen]);

  // Play an item's audio if a file is loaded; otherwise stop current playback.
  function playItemAudio(itemId: string) {
    // Through the refs, not the render closure: START now awaits the authority
    // probe before it plays, so a download that finished during that wait would
    // otherwise be invisible here and the show would open on "no audio" for a
    // file that is sitting on disk.
    const url = audioUrlsRef.current[itemId];
    const audio = audioRef.current;
    if (!audio) return;
    if (url) {
      endedItemRef.current = null;
      // already playing this exact item (e.g. started early via negative buffer) — don't restart
      if (playingIdRef.current === itemId && !audio.paused) {
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
  const primedRefs = useRef(new WeakSet<HTMLAudioElement>());
  function primeElement(el: HTMLAudioElement | null) {
    if (!el || primedRefs.current.has(el) || el.src) return;
    primedRefs.current.add(el);
    try {
      el.src = SILENT_WAV;
      el.play()
        .then(() => {
          el.pause();
          if (el.src === SILENT_WAV) el.removeAttribute("src");
        })
        .catch(() => {
          if (el.src === SILENT_WAV) el.removeAttribute("src");
        });
    } catch {
      /* nothing here may ever affect the show */
    }
  }
  function primeSecondaryAudio() {
    if (secondaryPrimedRef.current) return;
    secondaryPrimedRef.current = true;
    primeElement(audioRef2.current);
    // The PRIMARY element used to be unlocked for free, because START played the
    // first track on it inside the operator's own tap. START now waits on the
    // authority probe first, so by the time the track plays the gesture is over
    // and WebKit — which grants permission per ELEMENT — refuses it: an iPad
    // driving the show would go silent on song one. Prime both, in the tap.
    primeElement(audioRef.current);
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
  /**
   * Is another device holding SHOW-MAIN right now?
   *
   * syncSettled only proves that nobody ANSWERED within a couple of seconds, and a
   * controller phone in a pocket with a suspended socket cannot answer. That
   * silence used to read as "no show is running": START lit up, and pressing it
   * stamped a newer claim that the real controller then yielded to — adopting item
   * 0 and a fresh clock, and going silent. show_authority is the persisted mirror
   * of exactly that fact, and a suspended device's row is still fresh (the ghost
   * threshold is GHOST_MS 90s + CLOCK_SKEW_GRACE_MS 120s = 3.5 นาที — see
   * lib/show-authority.ts; it quoted the bare 90s for two review waves after the
   * grace was added), so ask it before overwriting someone's running show.
   *
   * Best-effort like every other authority call: offline resolves to [] and the
   * show starts as it always has.
   */
  async function otherDeviceHoldsShow(): Promise<string | null> {
    // BOUNDED. The venue failure this app is built for is not "offline" — it is
    // "associated to the AP with no route out", where navigator.onLine is still
    // true and a fetch simply never settles (supabase's client sets no timeout).
    // An unbounded await here would make START do nothing at all, with no spinner
    // and no error, at the top of the show. Not knowing is the same answer as
    // nobody holding it: best-effort has to mean bounded, not just caught.
    const rows = await Promise.race([
      getAuthority(eventId),
      new Promise<AuthorityRow[]>((r) => setTimeout(() => r([]), 1500)),
    ]);
    const main = rows.find(
      (r) =>
        r.kind === "show_main" &&
        r.device_id !== deviceIdRef.current &&
        !isGhost(r)
    );
    return main ? (main.device_label ?? "เครื่องอื่น") : null;
  }

  // START is now asynchronous (the authority probe above), and `begun` is set at
  // the END of it — so for the whole round trip the button stays enabled and the
  // Space handler still sees begun=false. A double-tap, or Space auto-repeat on a
  // held key, would run start() twice: the second one stamps a fresh startedAt and
  // replays item 0, audibly restarting the show seconds after it began.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);

  async function start() {
    // First sync still pending — we don't yet know whether a show is already
    // running elsewhere, and starting now would hijack/reset it to item 0.
    // (Guards the Space shortcut; the START button is also disabled until then.)
    if (!syncSettled || startingRef.current || stateRef.current.begun) return;
    startingRef.current = true;
    setStarting(true);
    try {
      primeSecondaryAudio(); // must happen inside this tap, before any await — see the helper
      const holder = await otherDeviceHoldsShow();
      if (
        holder &&
        !window.confirm(
          `ดูเหมือนโชว์กำลังรันอยู่บนเครื่อง “${holder}” — เริ่มใหม่ที่นี่จะรีเซ็ตโชว์นั้นกลับไปเพลงแรกและปิดเสียงเครื่องนั้น ยืนยันจะเริ่มไหม?`
        )
      ) {
        return;
      }
      // Re-read after the await: a controller elsewhere may have started the show
      // while this probe was in flight, and adopting it is not the same as
      // starting one.
      if (stateRef.current.begun) return;
      startShow();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  function startShow() {
    markShowEnded(false);
    const ts = Date.now();
    controllerSinceRef.current = ts; // this device began the show → it is the controller as of now
    // Read through the refs, not the render closure: start() now awaits the
    // authority probe first, so a mode change or a setlist refetch can have landed
    // in between.
    const mode = stateRef.current.mode;
    const first = itemsRef.current[0];
    apply({
      running: true,
      begun: true,
      startedAt: ts,
      itemStartedAt: ts,
      itemElapsedAtPause: null,
      currentIndex: 0,
      // Auto begins running the script immediately; Manual still plays the FIRST
      // song and runs its countdown right away (a natural "go"), then waits for
      // the operator on every item after it.
      mode,
    });
    if (first) playItemAudio(first.id);
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
    /* 🔒 A HELD KEY IS ONE INTENTION, NOT FIFTY — but the guard goes INSIDE each branch,
       AFTER preventDefault, and that placement is the whole point.
       The OS repeats `keydown` ~30×/second while a key stays down. In a dark venue that is
       not theoretical: a hand resting on the laptop, a bag lid, a cable across the desk.
       Held Space used to flip run/pause dozens of times and broadcast every flip, so where
       the finger lifted decided the show — a coin toss whose losing side is a stopped show.
       Held →/N walked the band through their own setlist.
       ⚠️ The first attempt at this returned on `e.repeat` at the TOP of the handler, which
       fixed the spam and introduced a new bug: Space is the browser's page-scroll key, and
       every repeat that returns early never reaches preventDefault, so a held spacebar
       scrolled the transport row off the screen mid-show on the machine wired to the PA.
       Suppressing the browser's default is this handler's job on every repeat; ACTING is
       the part that must happen once. */
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      if (!s.begun) void start();
      else toggleShowRun();
    } else if (e.key === "ArrowRight" || e.key === "n" || e.key === "N") {
      if (s.begun && s.mode === "manual" && s.currentIndex < n - 1) {
        e.preventDefault();
        if (e.repeat) return;
        goto(s.currentIndex + 1);
      }
    } else if (e.key === "ArrowLeft") {
      if (s.begun && s.mode === "manual" && s.currentIndex > 0) {
        e.preventDefault();
        if (e.repeat) return;
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
  // Each row's planned start on the wall clock: when the show first ran + the planned
  // blocks before it. Display only; nothing reads it back. Blank until the show has
  // a start. Depends on nothing the rows below do not already depend on.
  const plannedStarts = useMemo(() => {
    let at = 0;
    return items.map((it) => {
      const clock = state.startedAt != null ? nowClock(new Date(state.startedAt + at * 1000)).slice(0, 5) : "";
      at += blockSeconds(it);
      return clock;
    });
  }, [items, state.startedAt]);

  // Stage rows (spec §G.10): idx · kind · title · planned start · length, and the
  // admin's row keys only in edit mode (`data-edit` on the Running Order section,
  // read by CSS, so the memo below never depends on it).
  const upcomingRows = useMemo(
    () =>
      items.map((it, i) => {
        const hasLocal = !!audioUrls[it.id];
        const hasFile = hasLocal || !!it.audio_path; // online file counts even if not downloaded yet
        const busy = audioBusy[it.id];
        const isPlayingThis = playingId === it.id && audioPlaying;
        const locked = state.mode === "auto" || !isController;
        const plannedStart = plannedStarts[i];
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
              // shrink-0: in the stage column's fixed-height stack an edit-mode row
              // (44 px of ▲▼) must scroll the list, never be squeezed under its keys
              "slab relative flex min-h-[52px] w-full shrink-0 items-center gap-2 px-3 stage:min-h-[29px] stage:gap-1.5 stage:rounded-none stage:px-2.5 stage:shadow-none",
              i < state.currentIndex && "text-faint",
              i === state.currentIndex &&
                "bg-primary/[.14] shadow-[inset_4px_0_0_hsl(var(--primary))] stage:bg-primary/[.16] stage:shadow-[inset_4px_0_0_hsl(var(--primary))]"
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
                title="ลากเพื่อสลับลำดับ"
                // A phone (coarse pointer, not stage) gets neither the grip nor the ▲▼
                // keys (CQ-17: the keys are stage-only, a phone reorders in the setlist
                // editor), and the title its room back. Stage shows the grip in edit mode
                // only, on the iPad too: iPadOS starts HTML drag from a long-press. The
                // edit-mode rule outranks the coarse-pointer one by specificity, because
                // an arbitrary @media variant is emitted AFTER the stage screen and a
                // plain `stage:inline` would lose to it.
                className="-ml-1 shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing [@media(pointer:coarse)]:hidden stage:hidden stage:group-data-[edit=on]/ro:inline-flex"
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
                "flex min-w-0 flex-1 items-center gap-2 self-stretch text-left text-[15px] stage:gap-1.5 stage:text-[13.5px]",
                locked && "cursor-default"
              )}
            >
              <span className="w-6 shrink-0 text-center stage:w-[18px] stage:text-right">
                {i < state.currentIndex ? (
                  <>
                    <Check aria-hidden className="inline size-3.5 text-success-ink" />
                    <span className="sr-only">{i + 1}</span>
                  </>
                ) : (
                  <span
                    className={cn(
                      "num text-[15px] stage:text-[14px]",
                      i === state.currentIndex ? "text-primary-ink" : "text-faint"
                    )}
                  >
                    {i + 1}
                  </span>
                )}
              </span>
              {/* stage edit mode lends the tile's 28 px to the title, beside the keys */}
              <KindTile
                kind={it.kind as SetlistKind}
                cover={it.song_id ? songCovers[it.song_id] ?? null : null}
                className="stage:!size-[22px] stage:[&_svg]:!size-3 stage:group-data-[edit=on]/ro:hidden"
              />
              {/* Phone: the title gets the row's whole width, wrapping to a second line
                  before it is cut (an admin's edit keys leave it ~126 px, and one
                  line cut a real "[SYSTEM_BOOT] SE (Overture)" to "…SE (Ove…"), the
                  marks and the length under it. Stage keeps its one truncated line.
                  Stage: one 29 px line ending in two right-aligned columns,
                  planned start and length; edit mode goes back to two lines, so the
                  title keeps its room beside the keys. */}
              <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 stage:flex-row stage:items-center stage:justify-start stage:gap-1.5 stage:group-data-[edit=on]/ro:flex-col stage:group-data-[edit=on]/ro:items-stretch stage:group-data-[edit=on]/ro:justify-center stage:group-data-[edit=on]/ro:gap-0.5">
                <span
                  className={cn(
                    "min-w-0 line-clamp-2 break-words stage:line-clamp-none stage:truncate stage:flex-1 stage:group-data-[edit=on]/ro:flex-none",
                    i === state.currentIndex && "font-semibold"
                  )}
                >
                  {it.title || "—"}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {i === state.currentIndex && (
                    <span aria-hidden className={cn("onair-dot", !state.running && "animate-none")} />
                  )}
                  {/* the track sounding right now (static: no pulse on this screen) */}
                  {isPlayingThis && <Volume2 aria-hidden className="size-3.5 shrink-0 text-primary-ink" />}
                  {busy && !canEdit && (
                    <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  )}
                  {i === state.currentIndex + 1 && (
                    <span className="chip chip-neutral en h-5 shrink-0 px-1.5 !text-[11px] !tracking-[.12em]">Next</span>
                  )}
                  <span
                    title={plannedStart ? "เริ่มตามแผน" : undefined}
                    className="num hidden min-w-[38px] text-right text-[14px] text-faint stage:inline-block stage:group-data-[edit=on]/ro:hidden"
                  >
                    {plannedStart}
                  </span>
                  <span className="num text-[13px] text-muted-foreground stage:min-w-[36px] stage:text-right stage:text-[15px]">
                    {formatDuration(it.duration_seconds)}
                  </span>
                </span>
              </span>
            </button>

            {/* The admin's row keys. Every slot is kept on every row (a row with no
                file holds an empty loop slot), so the keys and the lengths line up
                down the list. Stage: only in edit mode, at 36 px. */}
            {canEdit && (
              <div className="flex shrink-0 items-center gap-1 stage:hidden stage:group-data-[edit=on]/ro:flex">
                {/* quick reorder — Admin + Manual + controller only (detailed edits = setlist editor).
                    Stage only (CQ-17): on a phone the two 22 px keys took ~28 px from a title that
                    already shares the row with the Loop and file keys, and a thumb on a 22 px key
                    mid-show is how a running order gets reordered by accident. */}
                {!locked && (
                  <div className="hidden flex-col stage:flex">
                    <button
                      onClick={() => moveItem(i, -1)}
                      disabled={i === 0}
                      title="เลื่อนขึ้น"
                      className="flex h-[22px] w-7 items-center justify-center rounded-[2px] text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                    >
                      <ChevronUp aria-hidden className="size-3.5" />
                    </button>
                    <button
                      onClick={() => moveItem(i, 1)}
                      disabled={i === items.length - 1}
                      title="เลื่อนลง"
                      className="flex h-[22px] w-7 items-center justify-center rounded-[2px] text-muted-foreground/50 hover:text-foreground disabled:opacity-20"
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </button>
                  </div>
                )}
                {hasFile ? (
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
                      "flex h-11 w-11 items-center justify-center rounded-[2px] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent stage:h-9 stage:w-9",
                      it.loop_audio
                        ? "text-primary-ink"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                    )}
                  >
                    <Repeat aria-hidden className="size-3.5" />
                  </button>
                ) : (
                  <span aria-hidden className="h-11 w-11 shrink-0 stage:h-9 stage:w-9" />
                )}
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
                    "flex h-11 w-11 items-center justify-center rounded-[2px] transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent stage:h-9 stage:w-9",
                    hasFile
                      ? "text-primary-ink"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  {busy ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <FolderOpen aria-hidden className="size-3.5" />
                  )}
                </button>
              </div>
            )}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, state, playingId, audioPlaying, audioUrls, audioBusy, isController, plannedStarts, songCovers]
  );

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-4 py-6">
        <Link href={`/events/${eventId}`} className="inline-flex h-11 items-center gap-2 self-start text-[15px]">
          <ArrowLeft aria-hidden className="size-5" />
          กลับไปหน้างาน
        </Link>
        <div className="slab p-10 text-center text-muted-foreground">
          ยังไม่มีรายการในเซ็ตลิสต์ — เพิ่มเพลงก่อนเริ่ม Live Mode
        </div>
      </div>
    );
  }

  // The one-tap fades. Rendered in the NOW card, and again in Live tools for the
  // landscape phone only, where the card has no room for them (CSS picks one; the
  // keys carry no test id, so nothing that counts ids sees two). Stage text is 14 px
  // until the window is 1060 px wide, then 16: "Auto Loudness" needs ~123 px of its
  // grid track at 14 px and ~136 px at 16 px; a 1024 px iPad's NOW column used to give
  // it 115 (fixed 300 + 320 side columns) and gives it ~127 now (290 px running order).
  const fadeKeys = (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => fadeVolumeTo(0, 3000)}
        disabled={!isController}
        title="ค่อย ๆ ปิดเสียงเป็น 0% ใน 3 วินาที"
        className="en h-11 min-w-0 gap-1.5 rounded-[2px] px-1 !text-[14px] stage:h-12 stage:[@media(min-width:1060px)]:!text-[16px]"
      >
        <VolumeX aria-hidden />
        Auto Mute
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => fadeVolumeTo(30)}
        disabled={!isController}
        title="ค่อย ๆ ลดเสียงลงเป็น 30% ใน 2 วินาที (ช่วง MC)"
        className="en h-11 min-w-0 gap-1.5 rounded-[2px] px-1 !text-[14px] stage:h-12 stage:[@media(min-width:1060px)]:!text-[16px]"
      >
        <Volume1 aria-hidden />
        MC
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => fadeVolumeTo(100, 2500)}
        disabled={!isController}
        title="ค่อย ๆ เพิ่มเสียงกลับเป็น 100% ใน 2.5 วินาที"
        className="en h-11 min-w-0 gap-1.5 rounded-[2px] px-1 !text-[14px] stage:h-12 stage:[@media(min-width:1060px)]:!text-[16px]"
      >
        <Volume2 aria-hidden />
        Auto Loudness
      </Button>
    </>
  );

  return (
    <div
      // ONE DOM for every screen, reflowed by CSS only (a JS media query would
      // remount the audio engine). Phone: a scrolling column over the fixed dock.
      // Stage (landscape iPad / laptop): exactly one screen tall, nothing scrolls.
      // `zone-over` lights the hazard rails and the screen-edge alarm frame
      // (app/stage.css). No transform or filter here — they would trap the fixed
      // dock, the Live tools sheet and that frame inside this box.
      // Landscape phone: a wrapping ROW, so NOW | NEXT sit side by side right under
      // the top bar and `order` sends the status rows below them — the 390 px height
      // cannot hold a status row AND the NOW card above the dock. (A grid would end
      // the sticky top bar at its own row; a flex container keeps it sticky.)
      className={cn(
        "live-root relative mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-[calc(84px+max(12px,env(safe-area-inset-bottom)))] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:max-w-none [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:flex-row [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:flex-wrap [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:content-start [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:items-start [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:gap-x-3 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:px-6 stage:h-[100dvh] stage:max-w-none stage:gap-0 stage:overflow-hidden stage:px-0 stage:pb-[calc(112px+env(safe-area-inset-bottom))] stage:pl-[env(safe-area-inset-left)] stage:pr-[env(safe-area-inset-right)]",
        zone === "over" && "zone-over"
      )}
      // ── WHAT THIS DEVICE THINKS IT IS, readable from outside the process ──────
      // The same convention as `data-cueiq-screen` on the desktop shell, and here
      // for the same reason: the two-device smoke (desktop/scripts/run-smoke.mjs,
      // scenario "two-device") runs the PA and the joining phone as two separate
      // Electron processes, and the only thing it can read is the DOM. Every value
      // below is one half of a distinction that decides whether a show survives a
      // second device opening the page:
      //   controller — who may drive. Two of these is the round-8 critical bug.
      //   begun      — is a show RUNNING here. A joiner must adopt, never reset.
      //   index      — where the show is. The joiner must not move it.
      //   sound      — เครื่องเสียงคุมคนเดียว: exactly one device makes noise.
      // Attributes, not text: every label on this screen is Thai and one wording
      // change would silently stop a cross-process assertion from matching.
      data-cueiq-live={eventId}
      data-cueiq-live-controller={isController ? "1" : "0"}
      data-cueiq-live-begun={state.begun ? "1" : "0"}
      data-cueiq-live-index={String(state.currentIndex)}
      data-cueiq-live-sound={soundOutput ? "1" : "0"}
      data-cueiq-live-sync={syncStatus}
      data-cueiq-live-settled={syncSettled ? "1" : "0"}
    >
      {/* The page light (v3 Stage Wash). This immersive screen has no app frame, so
          it hangs its own — HERE, inside the root, because `zone-over` on the root
          swaps it to the neutral alarm light; aimed at the NOW column at stage size.
          The root is deliberately NOT isolated: the light paints in the immersive
          <main>'s stacking context, under everything in it, including whatever a
          page puts above LiveMode (the desktop's readiness card). The 50 % base is
          explicit: this root sits inside the app frame, whose lg aim
          (FRAME_LIGHT_AIM) it would otherwise inherit below stage size. */}
      <StageLight className="[--spot-x:50%] stage:[--spot-x:27%]" />
      {/* hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* ── TOP BAR ── back · ON AIR + sync · the show · (stage: the show stats) · the
          wall clock · Live tools. Glass, sticky, edge to edge. It also hosts the offline
          strip, so the page-level copy stands down and can never push this screen
          into a scroll in exactly the airplane case. The back control is an <a>: the
          leave guard above intercepts a[href], so leaving a running show still asks. */}
      <header className="live-top glass glass-top sticky top-0 z-40 -mx-4 shrink-0 pt-[env(safe-area-inset-top)] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:-mx-6 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:min-w-0 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-[calc(100%+48px)] stage:mx-0">
        <div className="flex h-[54px] items-center gap-1 px-1 stage:h-16 stage:gap-3 stage:pl-3 stage:pr-4">
          <Link
            href={`/events/${eventId}`}
            aria-label="กลับไปหน้างาน"
            title="กลับไปหน้างาน"
            className="grid size-11 shrink-0 place-items-center rounded-[3px] hover:bg-muted"
          >
            <ArrowLeft aria-hidden className="size-6" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {/* ON AIR blinks only while the clock runs; a paused or cued show holds it still. */}
              <span className="onair-tag">
                <i className={cn(!state.running && "!animate-none")} />
                On Air
              </span>
              <span
                title={syncReady ? "Sync ready" : `สถานะ: ${syncStatus}`}
                className={cn(
                  "flex min-w-0 items-center gap-1 text-[12px]",
                  syncReady ? "text-success-ink" : "text-warning-ink"
                )}
              >
                {syncReady ? (
                  <Wifi aria-hidden className="size-[13px] shrink-0" />
                ) : (
                  <WifiOff aria-hidden className="size-[13px] shrink-0" />
                )}
                <span className="truncate" suppressHydrationWarning>
                  {syncLabel}
                </span>
                {syncReady && state.begun && (
                  <span className="hidden shrink-0 stage:inline">
                    · {isController ? "เครื่องนี้คุมโชว์" : "ดูอย่างเดียว"}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-[3px] truncate text-[14px] font-semibold leading-tight stage:font-display stage:text-[21px] stage:font-extrabold stage:[font-synthesis:none]">
              {eventName}
            </div>
          </div>
          {/* Stage and a phone held sideways: the show strip rides up here (a phone
              upright keeps its own row). The landscape phone has no other place for
              the running totals, and an operator who cannot see them walks the show
              without noticing the accumulated clock. */}
          <div className="hidden items-center gap-3 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:flex stage:flex stage:gap-5">
            <Stat label="ผ่านไป">{formatDuration(totalElapsed)}</Stat>
            <Stat label="เหลือทั้งโชว์">{formatDuration(showRemaining)}</Stat>
            <Stat label="คาดจบ" suppress>
              {projectedEnd}
            </Stat>
            <div aria-hidden className="h-10 w-[3px] bg-foreground/15" />
          </div>
          <div className="shrink-0 pr-1 text-right stage:flex stage:flex-col-reverse">
            <div className="num text-[25px] leading-none stage:text-[28px]" suppressHydrationWarning>
              {wallClock}
            </div>
            <div className="mt-[2px] text-[10.5px] text-faint stage:mt-0 stage:text-[11px] stage:text-muted-foreground">
              เวลาจริง
            </div>
          </div>
          <button
            ref={toolsBtnRef}
            type="button"
            aria-label="Live tools"
            title="Live tools"
            aria-haspopup="dialog"
            aria-expanded={toolsOpen}
            onClick={openTools}
            className="grid size-11 shrink-0 place-items-center rounded-[3px] hover:bg-muted"
          >
            <Ellipsis aria-hidden className="size-[22px]" />
          </button>
        </div>
        {/* A phone held sideways has no 28 px to spare above the NOW card: there the
            sync line beside ON AIR already reads "ออฟไลน์ · โชว์เดินต่อ". The strip
            stays mounted, so the page-level copy still stands down. */}
        <div className="[@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:hidden">
          <OfflineBanner placement="header" />
        </div>
      </header>

      {/* ── TRANSIENT BANNERS ── between the top bar and the status row (a phone held
          sideways moves the informational ones below NOW | NEXT; the two that ask
          for a tap stay on top). */}
      {/* "What is this device right now" — it only shows when something needs attention. */}
      <LiveStatusStrip
        eventId={eventId}
        isController={isController}
        soundOutput={soundOutput}
        className="stage:mx-5 stage:mb-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-1 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full"
      />

      {/* Audio needs a tap to (re)start — after a reload / autoplay block. The one
          allowed fill on this screen, because it IS the action. */}
      {needsAudioResume && (
        <button
          type="button"
          onClick={resumeAudio}
          className="flex h-[52px] shrink-0 items-center justify-center gap-2 rounded-[2px] bg-warning px-4 font-semibold text-warning-foreground [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:mx-5 stage:mb-2"
        >
          <Volume2 aria-hidden className="size-5 shrink-0" /> แตะเพื่อเล่นเสียงต่อ (ตำแหน่งปัจจุบัน)
        </button>
      )}

      {/* A real playback failure on this device — the countdown keeps running, so
          say WHY the PA is silent instead of leaving the operator guessing. */}
      {audioFault && (
        <div className="flex shrink-0 items-center justify-between gap-2 rounded-[2px] bg-destructive/[.14] py-1 pl-3 pr-1 text-[13px] font-medium text-foreground [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:mx-5 stage:mb-2 [&_svg]:text-destructive">
          <span className="flex min-w-0 items-center gap-1.5">
            <VolumeX aria-hidden className="size-4 shrink-0" />
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
            className="h-11 shrink-0 rounded-[2px] px-3 text-[13px] hover:bg-foreground/10"
          >
            ปิด
          </button>
        </div>
      )}

      {/* Realtime dropped mid-show — make it obvious; the local show keeps running */}
      {state.begun && !syncReady && (
        <div className="flex shrink-0 items-center justify-center gap-2 rounded-[2px] bg-warning/[.16] px-3 py-2 text-[13px] font-medium text-warning-ink [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-1 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:mx-5 stage:mb-2">
          <span aria-hidden className="h-2 w-2 shrink-0 bg-warning" />
          การเชื่อมต่อหลุด — กำลังต่อใหม่ (โชว์ยังเดินต่อ)
        </div>
      )}

      {/* ── STATUS ROW ── this device's sound · audio readiness · Manual | Auto. A
          viewer gets its banner (and, on a sound device, ขอควบคุม) in place of the
          controls. Sound is LOCAL per device (never broadcast): the PA on, a remote
          off, so the remote stays silent without muting the PA. A phone held
          sideways shows it under NOW | NEXT (one short scroll), never hides it:
          Live tools has no copy of the sound key, Manual | Auto or ขอควบคุม. */}
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-1 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:h-[60px] stage:gap-2 stage:px-5 stage:pt-3">
        <button
          type="button"
          data-testid="sound-output-toggle"
          onClick={() => setSoundOutput((v) => !v)}
          title={
            soundOutput
              ? "เสียงออกที่เครื่องนี้ — แตะเพื่อปิดเสียงเฉพาะเครื่องนี้"
              : "เครื่องนี้เงียบอยู่ — แตะเพื่อให้เสียงออก"
          }
          className={cn(
            "chip chip-lg shrink-0 gap-[5px] px-2 text-[13px] stage:px-[11px] stage:text-[13.5px]",
            soundOutput ? "chip-success" : "chip-neutral"
          )}
        >
          {soundOutput ? (
            <>
              <Volume2 aria-hidden />
              เสียงออกเครื่องนี้
            </>
          ) : (
            <>
              <VolumeX aria-hidden />
              ปิดเสียงเครื่องนี้
            </>
          )}
        </button>
        {isController ? (
          <>
            {/* Pre-flight readiness — does THIS device hold every track's file, so the
                show plays offline? The full sentence is in Live tools. A non-admin's
                phone row trades it for โหมดซ้อม only once nothing is missing: a member
                rehearsing on a phone must still see "ในเครื่อง 3/14" before START. */}
            {audioItems.length > 0 && (
              <span
                title={readinessSentence}
                className={cn(
                  "chip chip-lg min-w-0 gap-[5px] overflow-hidden px-2 text-[13px] stage:text-[13.5px]",
                  allReady ? "chip-neutral" : "chip-warning",
                  !canEdit && allReady && "hidden stage:inline-flex"
                )}
              >
                {downloadingAudio && !allReady ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <HardDriveDownload aria-hidden />
                )}
                {/* Word, count and stage suffix are separate items on one baseline: the
                    ellipsis must eat the word, never the count. A 360 / 375 px phone
                    gives this chip ~85 px after the sound chip and Manual | Auto, the
                    icon and the count take all but 7 / 22 of them, and a word that
                    narrow cannot even show an ellipsis (a clipped half-glyph, "ห").
                    Under 390 px it steps aside whole (sr-only: out of the layout, still
                    in the accessible text): the icon, the count and the amber of the
                    warning still say it, and the title holds the sentence. Each
                    text span is alone on its line at the chip's line-height 1, so
                    py/-my gives Kanit's tone marks room inside its clip at the same
                    height. */}
                <span className="flex min-w-0 items-baseline gap-[.25em]">
                  <span className="min-w-0 truncate py-[.25em] -my-[.25em] [@media(max-width:389.98px)]:sr-only">
                    {allReady ? "พร้อม" : downloadingAudio ? "กำลังโหลด" : "ในเครื่อง"}
                  </span>
                  <span className="num shrink-0 text-[16px]">
                    {readyCount}/{audioItems.length}
                  </span>
                  {allReady && (
                    <span className="hidden min-w-0 truncate py-[.25em] -my-[.25em] stage:block">
                      · เล่นได้แม้เน็ตหลุด
                    </span>
                  )}
                </span>
              </span>
            )}
            {/* Non-admins may play/รัน to rehearse but never edit live. Below stage it
                gives way to the readiness warning (its sentence opens Live tools). */}
            {!canEdit && (
              <span
                title={REHEARSAL_NOTE}
                className={cn(
                  "chip chip-lg chip-info shrink-0 gap-[5px] px-2 text-[13px]",
                  !allReady && "hidden stage:inline-flex"
                )}
              >
                <GraduationCap aria-hidden />
                โหมดซ้อม
              </span>
            )}
            <div
              role="group"
              aria-label="Show mode"
              className="seg quiet en ml-auto w-[100px] flex-none stage:w-[210px]"
            >
              <button
                type="button"
                onClick={() => setMode("manual")}
                disabled={!isController}
                aria-pressed={state.mode === "manual"}
                className={cn(
                  "!px-1 !text-[13px] disabled:opacity-50 stage:!text-[15px]",
                  state.mode === "manual" && "on"
                )}
              >
                <Hand aria-hidden className="hidden size-4 stage:block" />
                Manual
              </button>
              <button
                type="button"
                onClick={() => setMode("auto")}
                disabled={!isController}
                aria-pressed={state.mode === "auto"}
                className={cn(
                  "!px-1 !text-[13px] disabled:opacity-50 stage:!text-[15px]",
                  state.mode === "auto" && "on"
                )}
              >
                <Sparkles aria-hidden className="hidden size-4 stage:block" />
                Auto
              </button>
            </div>
          </>
        ) : (
          <div
            data-testid="viewer-banner"
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[2px] bg-info/[.15] pl-2.5 pr-1 text-info-ink"
          >
            {audioPlaying ? (
              <Volume2 aria-hidden className="size-4 shrink-0" />
            ) : (
              <Eye aria-hidden className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {audioPlaying ? "เครื่องนี้เล่นเสียงอยู่ — คุมจากเครื่องอื่น" : "ดูอย่างเดียว — ซิงค์จากเครื่องคุม"}
            </span>
            {/* A viewer that SOUNDS plays from its own files too: say which it lacks
                (3ddf617's readiness banner reached every device). */}
            {soundOutput && audioItems.length > 0 && !allReady && (
              <span title={readinessSentence} className="chip chip-warning shrink-0 gap-1 px-1.5 text-[12px]">
                {downloadingAudio ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <HardDriveDownload aria-hidden />
                )}
                <span className="num text-[14px]">
                  {readyCount}/{audioItems.length}
                </span>
              </span>
            )}
            {/* เครื่องเสียงคุมคนเดียว: only a sound-output device may take control.
                A muted viewer sees no take-control button — turn its sound on first
                to become the show device (audio + control move here together). */}
            {soundOutput && (
              <Button
                size="sm"
                variant="secondary"
                data-testid="request-control"
                onClick={takeControl}
                className="h-9 shrink-0"
              >
                ขอควบคุม
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── SHOW STRIP ── phone portrait only (stage carries it in the top bar). */}
      <div className="grid shrink-0 grid-cols-3 gap-[2px] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:hidden stage:hidden">
        <div className="slab min-w-0 px-3 py-1">
          <div className="truncate text-[11px] text-muted-foreground">ผ่านไป</div>
          <div className="num text-[25px] leading-[1.05]">{formatDuration(totalElapsed)}</div>
        </div>
        <div className="slab min-w-0 px-3 py-1">
          <div className="truncate text-[11px] text-muted-foreground">เหลือทั้งโชว์</div>
          <div className="num text-[25px] leading-[1.05]">{formatDuration(showRemaining)}</div>
        </div>
        <div className="slab min-w-0 px-3 py-1">
          <div className="truncate text-[11px] text-muted-foreground">คาดจบ</div>
          <div className="num text-[25px] leading-[1.05]" suppressHydrationWarning>
            {projectedEnd}
          </div>
        </div>
      </div>

      {/* ── THE BOARD ── phone: one column. Landscape phone: `contents`, so NOW and
          NEXT become two half-width items of the root's wrapping row (the status
          rows, then the order, follow them). Stage: NOW | NEXT + SHOW | the running
          order, no page scroll. NOW takes what the two side columns leave. NEXT
          holds 300 px at every width: its label row (NEXT, the index, the kind
          chip and a 48 px length) is ~260 px wide for a 12:00 block, so a narrower
          card spills the length over the running order. The running order gives
          the ground instead: 320 px from 1175 px up (the approved widths on both
          iPads), easing to 290 px at 1100 px and below. That hands NOW 30 of the ~50
          px its title and fade keys were short of at 1024 (362 px: "Auto Loudness"
          needs ~123 px of its ~127 px track at 14 px, ~136 of 142 at 16 px from
          1060), and gives a running-order row 20 px over the 270 px it first had:
          the row with the NEXT chip keeps 68 px of title instead of 48, and in
          edit mode ~20 px between its marks and the ▲▼ keys instead of 0. */}
      <div className="flex flex-col gap-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:contents stage:grid stage:min-h-0 stage:flex-1 stage:grid-cols-[minmax(0,1fr)_300px_clamp(290px,calc(40vw_-_150px),320px)] stage:grid-rows-[minmax(0,1fr)] stage:gap-4 stage:px-5 stage:pb-3 stage:pt-2">
        <NowCard
          zone={zone}
          blockSec={zoneBlock}
          remaining={remaining}
          elapsed={elapsedItem}
          index={state.currentIndex + 1}
          total={items.length}
          kind={(current?.kind as SetlistKind | undefined) ?? null}
          title={current?.title || "—"}
          cover={currentCover}
          note={current?.notes ?? null}
          endClock={itemEndClock}
          canAdvance={!nextLocked}
        >
          {/* The one-tap fades — on the device that holds the file, or the controller
              riding the speaker device's level by remote. */}
          {current && (currentAudioUrl || (isController && state.begun)) ? (
            <>
              <div className="grid grid-cols-[1.05fr_.72fr_1.25fr] gap-[3px]">{fadeKeys}</div>
              {/* Stage only: the track's level under the fades (the phone has it in Live tools).
                  It is the first row the NOW card gives up when the card gets short (the
                  card is a size container on stage, see now-card.tsx): the stage now starts
                  at 600 px, where every row above the countdown leaves it 64, and a banner
                  takes 60 more. Live tools still carries the slider. */}
              <div className="mt-2.5 hidden min-w-0 items-center gap-2.5 text-[12.5px] text-muted-foreground stage:flex [@container_(max-height:334px)]:hidden">
                <Volume1 aria-hidden className="size-4 shrink-0" />
                <span className="shrink-0">ความดัง</span>
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
                  className="min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="num shrink-0 text-[16px] text-foreground">{volumes[current.id] ?? 100}%</span>
                {currentAudioUrl && (
                  <span className="min-w-0 max-w-[40%] truncate">· {audioNames[current.id]}</span>
                )}
              </div>
              {/* iOS: the keys above animate and the PA stays at full level — said HERE,
                  beside them (the standing decision: the app says so on that device),
                  not only in the closed Live tools sheet. The sound host only. */}
              {volumeIsDead && soundOutput && (
                <p className="mt-2 text-[12px] leading-snug text-warning-ink stage:text-[12.5px]">
                  เครื่องนี้ (iPhone/iPad) ปรับ “ระดับเสียง” ในแอปไม่ได้ — สไลเดอร์กับปุ่มหรี่เสียงจะไม่มีผลจริง
                  ใช้ปุ่มเพิ่ม/ลดเสียงข้างเครื่อง หรือให้เครื่องอื่นเป็นตัวปล่อยเสียงแทน (ปุ่มปิดเสียงยังใช้ได้)
                </p>
              )}
            </>
          ) : null}
        </NowCard>

        {/* NEXT (and, on stage, the SHOW totals under it) */}
        <div className="flex min-w-0 flex-col gap-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-[calc(50%-6px)] stage:min-h-0 stage:gap-3">
          <section className="slab shrink-0 px-4 pb-3 pt-2 stage:px-5 stage:pb-4 stage:pt-3.5">
            {next ? (
              <>
                {/* The length rides the label row on every screen, so the title gets
                    the column's whole width: at stage a 48 px length beside a 30 px
                    title left ~170 px and cut "Seishin Kakumei" to "Seishin Kak…". */}
                <div className="flex h-7 min-w-0 items-center gap-2 stage:h-12">
                  <span className="nlabel">Next</span>
                  {/* the index alone: "/ 16" no longer fits beside a 48 px length at
                      stage, and the NOW card and the running order both print it */}
                  <span className="num shrink-0 text-[16px] text-faint">{pad2(state.currentIndex + 2)}</span>
                  {next.kind && <KindChip kind={next.kind as SetlistKind} className="shrink-0" />}
                  <span className="num ml-auto shrink-0 text-[26px] leading-none stage:text-[48px] stage:font-extrabold">
                    {formatDuration(blockSeconds(next))}
                  </span>
                </div>
                {/* py + -my (stage's 4 px gap folded into its margin): the clip is the
                    padding box, so Kanit's tone marks and ุ / ู get room the 1.02
                    line box does not have, and the card keeps its height. */}
                <div className="disp min-w-0 truncate py-[.25em] -my-[.25em] text-[22px] leading-tight stage:mt-[calc(4px_-_.25em)] stage:text-[30px] stage:leading-[1.02]">
                  {next.title || "—"}
                </div>
                <div className="mb-1.5 mt-2.5 hidden items-center gap-1.5 text-[12.5px] text-muted-foreground stage:flex">
                  <Mic aria-hidden className="size-3.5" />
                  เตรียมไมค์
                </div>
                {next.mic_slots?.length > 0 ? (
                  <MicGrid
                    className="mt-2 stage:mt-0"
                    mics={next.mic_slots.map((s) => ({
                      mic: s.mic,
                      name: s.member,
                      color: "hsl(var(--foreground) / .3)",
                    }))}
                  />
                ) : (
                  // Per-song mic slots are only the SWAPS. A show whose members hold
                  // standing mic numbers has none, and "no mics to prepare" read as
                  // "no mics at all" — so say where the mics come from: the Mic Map.
                  // "The same as before" was wrong whenever NOW HAS swaps: the
                  // swapped mics go back to the Mic Map for this song, so say that.
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    — {(current?.mic_slots?.length ?? 0) > 0 ? "กลับไมค์ตาม Mic Map" : "ไมค์ตาม Mic Map"} —
                  </p>
                )}
                {/* The cue the band typed for what's coming — capped and scrollable,
                    never cut, so a long MC script stays reachable. */}
                {next.notes && (
                  <p className="mt-2 flex max-h-16 items-start gap-1.5 overflow-y-auto break-words text-[13px] text-muted-foreground stage:mt-3 stage:bg-muted stage:px-3 stage:py-2">
                    <Lightbulb aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0">{next.notes}</span>
                  </p>
                )}
              </>
            ) : (
              <div className="py-3 text-center text-muted-foreground">
                <p className="text-lg font-semibold">— จบโชว์ —</p>
                <p className="text-sm">ไม่มีรายการถัดไปแล้ว</p>
              </div>
            )}
          </section>

          {/* Under 700 px tall (a 600-699 stage: a 768p laptop, an iPad mini's Safari tab) the
              slab cannot hold even its two tiles and would stand as an empty "SHOW" plate,
              which reads as missing data; the whole slab steps aside instead. The top bar
              prints the same totals (ผ่านไป · เหลือทั้งโชว์ · คาดจบ). */}
          <section className="slab hidden min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4 pt-3.5 stage:flex stage:[container-type:size] stage:[@media(max-height:699.98px)]:hidden">
            <span className="nlabel [@container_(max-height:26px)]:hidden">Show</span>
            {/* The top bar already prints ผ่านไป, so when THIS SLAB is too short to show
                the big copy and its two tiles unclipped (the NEXT card with six mics
                and a note leaves it ~138 of the ~188 px it needs), the copy steps
                aside and both tiles keep their values. The slab asks, not the window:
                a viewport rule also hid the row on an iPad whose Safari toolbar leaves
                740 px of an 820 px screen while the slab had room, and "/ 12:00"
                (the planned total) is printed nowhere else on stage. The slab is a
                size container: a flex-1 / min-h-0 cell of a column whose height is
                definite on stage (root 100dvh tall -> board flex-1 -> grid row
                minmax(0,1fr)), so nothing sizes to its content and hiding the row
                cannot move the container. A query reads the CONTENT box, which has
                to hold 22 (label) + 8 + 54 (the row) + 12 + 62 (tiles) = 158 px
                (188 with the slab's 30 px of padding, as measured); 162 is that plus
                4 px. Without the row the tiles need 96 (126). No container queries
                (Safari < 16) = the row always shows, as before the viewport rule.
                Two steps more, for the stage that now starts at 600 px (CQ-20): NEXT
                with six mics and a note is ~293 px, the column is 100vh - 256, so at
                620 the slab is ~58 px and at 600 ~38, and the tiles were sliced
                through. When the content box cannot hold the tiles (96, + 4) they step
                aside too, and when it cannot hold the label (22, + 4) that goes: an
                empty plate, never a cut one. The top bar prints the same three totals
                (ผ่านไป · เหลือทั้งโชว์ · คาดจบ), so nothing is lost but "/ 12:00". */}
            <div className="mt-2 flex items-baseline gap-2 [@container_(max-height:162px)]:hidden">
              <span className="num text-[50px] font-extrabold leading-none">{formatDuration(totalElapsed)}</span>
              <span className="num text-[24px] text-faint">/ {formatDuration(plannedTotal)}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-[2px] [@container_(max-height:100px)]:hidden">
              <div className="well min-w-0 px-3 py-1.5">
                <div className="truncate text-[11px] text-muted-foreground">จบประมาณ</div>
                <div className="num text-[32px] leading-[1.05]" suppressHydrationWarning>
                  {projectedEnd}
                </div>
              </div>
              <div className="well min-w-0 px-3 py-1.5">
                <div className="truncate text-[11px] text-muted-foreground">เหลือทั้งโชว์</div>
                <div className="num text-[32px] leading-[1.05]">{formatDuration(showRemaining)}</div>
              </div>
            </div>
          </section>
        </div>

        {/* RUNNING ORDER (memoized — see upcomingRows) */}
        <section
          data-edit={orderEdit ? "on" : "off"}
          className="group/ro [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:flex stage:min-h-0 stage:flex-col stage:rounded-[2px] stage:bg-card stage:p-2.5 stage:shadow-edge"
        >
          <div className="hidden items-center gap-2 px-2 pb-1.5 pt-1 stage:flex">
            <h3 className="nlabel text-[19px]">Running Order</h3>
            <span className="ml-auto text-[12.5px] text-muted-foreground">
              <span className="num text-[15px] text-foreground">{state.currentIndex + 1}</span> /{" "}
              <span className="num text-[15px]">{items.length}</span>
            </span>
            {/* Stage only (phones always show their row keys): the admin's reorder,
                Loop and file keys stay out of the running order until asked for. */}
            {canEdit && (
              <button
                type="button"
                aria-pressed={orderEdit}
                onClick={() => setOrderEdit((v) => !v)}
                // (never the word ไฟล์เพลง: tests find a row's file key by it)
                title={orderEdit ? "ซ่อนปุ่มแก้ไขของแต่ละแถว" : "แสดงปุ่มแก้ไขของแต่ละแถว (สลับลำดับ · Loop · ไฟล์)"}
                className={cn("chip -my-1 h-8 shrink-0 gap-1.5 px-2.5 text-[13px]", orderEdit ? "chip-solid" : "chip-neutral")}
              >
                <Pencil aria-hidden />
                แก้ไข
              </button>
            )}
          </div>
          <div className="stack stage:min-h-0 stage:flex-1 stage:gap-px stage:overflow-y-auto">{upcomingRows}</div>
        </section>
      </div>

      {/* last-show time record — saved by จบโชว์, survives a normal Reset Show,
          cleared only by its own ล้าง button. On stage it lives in Live tools. */}
      {lastRun && (
        <LastRunRecord
          seconds={lastRun.seconds}
          at={lastRun.at}
          onClear={canEdit ? clearLastRun : null}
          className="shrink-0 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-3 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:hidden"
        />
      )}

      <p className="px-1 text-center text-[11px] text-faint [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:order-3 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:basis-full stage:hidden">
        <CloudUpload aria-hidden className="mr-1 inline size-3" />
        ไฟล์เพลงเก็บออนไลน์แบบส่วนตัว (เฉพาะคนที่ล็อกอิน) — ทุกเครื่องเล่นได้ และลบได้
      </p>

      {/* ── THE DOCK ── fixed 64 px side keys + a flex NEXT; nothing reflows when the
          show starts. Before START the centre slot is START and the side keys are
          inert placeholders (no test id, no handler: a live run-toggle before START
          would bypass the authority probe in start()). NEXT and its overtime invite
          share ONE lock, so the ring can never pulse on a key that cannot be pressed. */}
      <div className="dock glass glass-bottom fixed inset-x-0 bottom-0 z-40 pb-[max(12px,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-3 stage:flex stage:h-[calc(112px+env(safe-area-inset-bottom))] stage:items-center stage:gap-3 stage:px-5 stage:pb-[env(safe-area-inset-bottom)] stage:pt-2">
        <RunMeter
          blocks={runBlocks}
          playheadSeconds={state.begun ? playheadSec : null}
          className="absolute inset-x-0 top-0 hidden stage:block"
          trackClassName="h-2"
        />
        <div className="hidden w-[236px] shrink-0 text-[12.5px] leading-snug text-muted-foreground stage:block">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            {soundOutput ? (
              <Volume2 aria-hidden className="size-4 shrink-0 text-success-ink" />
            ) : (
              <VolumeX aria-hidden className="size-4 shrink-0" />
            )}
            <span className="truncate">
              {soundOutput ? "เสียงออกเครื่องนี้" : "ปิดเสียงเครื่องนี้"} · Crossfade {crossfade ? "เปิด" : "ปิด"}
            </span>
          </div>
          {isController && (
            <div className="mt-1.5 flex items-center gap-1">
              <kbd>Space</kbd> รัน <kbd className="ml-1">N</kbd> ถัดไป <kbd className="ml-1">←</kbd> ย้อน
            </div>
          )}
        </div>
        {/* 40rem, not 2xl: the cards above are the root's 42rem less its 1rem gutters,
            and this row already sits inside the dock's own 1rem, so 2xl stood 16 px
            outside the cards on each side on a portrait iPad. */}
        <div className="mx-auto flex max-w-[40rem] gap-2 [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:max-w-2xl stage:mx-0 stage:max-w-none stage:flex-1 stage:gap-3">
          {state.begun ? (
            <Button
              variant="dock"
              data-testid="prev"
              onClick={() => goto(state.currentIndex - 1)}
              disabled={!isController || state.mode === "auto" || state.currentIndex === 0}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "ย้อนกลับ"}
            >
              <SkipBack aria-hidden />
              Prev
            </Button>
          ) : (
            <Button variant="dock" type="button" disabled tabIndex={-1} aria-hidden className="disabled:opacity-40">
              <SkipBack aria-hidden />
              Prev
            </Button>
          )}
          {state.begun ? (
            <Button
              variant="next"
              data-testid="next"
              className={cn("min-w-0 flex-1", zone === "over" && !nextLocked && "next-invite")}
              onClick={() => goto(state.currentIndex + 1)}
              disabled={nextLocked}
              title={state.mode === "auto" ? "สลับเป็น Manual เพื่อข้ามเอง" : "รายการถัดไป"}
            >
              <span className="min-w-0 text-left leading-none">
                <span className="block font-display-x text-[32px] font-extrabold uppercase italic leading-[.82] tracking-[.03em] [font-synthesis:none] stage:text-[36px]">
                  Next
                </span>
                {/* py + margins that give it back (the 5 px gap included): at the key's
                    leading-none the clip cut Kanit's tone marks and ุ / ู */}
                <span className="-mb-[.25em] mt-[calc(5px_-_.25em)] block max-w-[170px] truncate py-[.25em] text-[12.5px] font-medium opacity-90 stage:max-w-none stage:text-[13.5px]">
                  {next ? next.title || "—" : "— จบโชว์ —"}
                  {next && (
                    <span className="hidden stage:inline">
                      {" "}
                      · <span className="num text-[16px]">{formatDuration(blockSeconds(next))}</span>
                    </span>
                  )}
                </span>
              </span>
              <SkipForward aria-hidden className="size-7 shrink-0 stage:size-8" />
            </Button>
          ) : (
            <Button
              variant="next"
              data-testid="start-show"
              className="min-w-0 flex-1"
              onClick={start}
              disabled={!isController || !syncSettled || starting}
              title={!syncSettled ? "กำลังซิงค์สถานะโชว์กับเครื่องอื่น…" : undefined}
            >
              <span className="min-w-0 text-left leading-none">
                {/* 26 px, not NEXT's 32: "START SHOW" measured 154 px at 32 and ran
                    into the Play icon on a 390 px phone (125 px fits; under 380 px the
                    icon steps aside instead). */}
                <span className="block font-display-x text-[26px] font-extrabold uppercase italic leading-[.82] tracking-[.03em] [font-synthesis:none] stage:text-[36px]">
                  Start Show
                </span>
                {/* room for "เริ่ม"'s mai ek inside the clip — see NEXT's subtitle */}
                <span className="-mb-[.25em] mt-[calc(5px_-_.25em)] block max-w-[170px] truncate py-[.25em] text-[12.5px] font-medium opacity-90 stage:max-w-none stage:text-[13.5px]">
                  {/* The authority probe is in flight (bounded to 1.5s): saying so beats a
                      key that looks alive and does nothing on a half-dead link. */}
                  {starting
                    ? "กำลังเริ่ม…"
                    : !syncSettled
                      ? "กำลังซิงค์สถานะโชว์…"
                      : `เริ่ม ${items[0]?.title || "—"}${firstKind ? ` (${firstKind})` : ""}`}
                </span>
              </span>
              {starting || !syncSettled ? (
                <Loader2 aria-hidden className="size-7 shrink-0 animate-spin [@media(max-width:379.98px)]:hidden" />
              ) : (
                <Play aria-hidden className="size-7 shrink-0 [@media(max-width:379.98px)]:hidden" />
              )}
            </Button>
          )}
          {state.begun ? (
            <Button
              variant="dock"
              data-testid="run-toggle"
              onClick={toggleShowRun}
              disabled={!isController}
              /* Nothing else on this screen says this key starts the accumulated
                 clock — an operator who only presses NEXT walks the whole show with
                 the timer at zero. The meaning lives in the tooltip. */
              title={state.running ? "กำลังจับเวลาโชว์ — แตะเพื่อพัก" : "เริ่มรันโชว์ (เริ่มจับเวลาสะสม)"}
            >
              {state.running ? (
                <>
                  <Pause aria-hidden />
                  Pause
                </>
              ) : (
                <>
                  <Play aria-hidden />
                  Run
                </>
              )}
            </Button>
          ) : (
            <Button variant="dock" type="button" disabled tabIndex={-1} aria-hidden className="disabled:opacity-40">
              <Pause aria-hidden />
              Pause
            </Button>
          )}
        </div>
      </div>

      {/* ── LIVE TOOLS ── everything a show needs only now and then. Always mounted (the
          output picker inside keeps watching for an unplugged device) and NOT a Radix
          dialog: nothing may stand between a tap and its handler on this screen. It
          sits outside the glass bars, whose backdrop-filter would trap a fixed child. */}
      <div
        hidden={!toolsOpen}
        className="fixed inset-0 z-50"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Only Escape pressed IN the sheet: the Feedback dialog is portalled out of
            // this DOM, and its own Escape must close it, not the sheet under it.
            if (e.currentTarget.contains(e.target as Node)) closeTools();
            return;
          }
          // Tab pressed IN the sheet wraps inside it (the Feedback dialog, portalled
          // out of this DOM, keeps its own Radix trap).
          if (e.key === "Tab" && e.currentTarget.contains(e.target as Node)) {
            wrapTabInside(e, e.currentTarget.querySelector<HTMLElement>('[role="dialog"]'));
          }
          // Every other key stays in the modal. The window's Live shortcuts would
          // otherwise fire behind it: Space on the focused ปิด would START the show
          // (or pause it mid-show) and N / → / ← would walk the setlist. React's
          // stopPropagation halts the native event at the React root, or at the
          // portal container for the Feedback dialog opened from here, so it never
          // reaches the window listener.
          e.stopPropagation();
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 touch-none overscroll-none bg-[hsl(var(--scrim)/var(--scrim-a))]"
          onClick={closeTools}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Live tools"
          // Focusable, so a click on the sheet's own padding keeps focus (and every
          // key after it) inside the sheet instead of dropping it to <body>.
          tabIndex={-1}
          className="absolute inset-x-0 bottom-0 max-h-[88dvh] animate-sheet-in overflow-y-auto overscroll-contain rounded-t-[12px] bg-popover px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-2 text-popover-foreground shadow-elev-2 outline-none sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:max-h-[85vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-none sm:rounded-[4px] sm:p-6"
        >
          <div aria-hidden className="mx-auto mb-3 mt-1 h-1 w-9 rounded-[2px] bg-foreground/25 sm:hidden" />
          <h3 className="h2 pr-12">Live Tools</h3>
          <button
            ref={toolsCloseRef}
            type="button"
            aria-label="ปิด"
            title="ปิด"
            onClick={closeTools}
            className="absolute right-3 top-3 grid size-11 place-items-center rounded-[2px]"
          >
            <span className="grid size-8 place-items-center rounded-[2px] bg-muted">
              <X aria-hidden className="size-4" />
            </span>
          </button>

          {/* Now — the ON-NOW item's whole cue and its mics. The NOW card has one
              note line (none in overtime or on a phone held sideways) and no mics,
              and NEXT has already moved on; 3ddf617's countdown card showed both. */}
          {current && (current.notes || current.mic_slots?.length > 0) && (
            <>
              <h4 className="eyebrow key mb-2 mt-5">Now</h4>
              <p className="mb-2 truncate text-[14px] font-semibold">{current.title || "—"}</p>
              {current.notes && (
                <p className="mb-2 flex max-h-40 items-start gap-1.5 overflow-y-auto overscroll-contain rounded-[2px] bg-muted px-3 py-2 text-[13px]">
                  <Lightbulb aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-pre-wrap break-words">{current.notes}</span>
                </p>
              )}
              {current.mic_slots?.length > 0 && (
                <MicGrid
                  mics={current.mic_slots.map((s) => ({
                    mic: s.mic,
                    name: s.member,
                    color: "hsl(var(--foreground) / .3)",
                  }))}
                />
              )}
            </>
          )}

          {/* Show */}
          <h4 className="eyebrow key mb-2 mt-5">Show</h4>
          {!canEdit && (
            <p className="mb-2 flex items-start gap-1.5 text-[13px] text-info-ink">
              <GraduationCap aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">{REHEARSAL_NOTE}</span>
            </p>
          )}
          {/* จบโชว์ — freezes + saves the accumulated time as the last-show record.
              Not a reset: Reset Show still clears the live state separately. */}
          {state.begun && isController && canEdit && (
            <Button
              variant="outline"
              data-testid="end-show"
              className="h-12 w-full justify-start"
              onClick={endShow}
              title="หยุดนับเวลาสะสม + บันทึกเป็นเวลาโชว์ล่าสุด (ไม่ใช่รีเซ็ต)"
            >
              <Flag aria-hidden />
              จบโชว์ · บันทึกเวลาสะสม
            </Button>
          )}
          {state.begun && (
            <Button
              variant="destructive-outline"
              data-testid="reset"
              className="mt-2 h-12 w-full justify-start"
              onClick={reset}
              disabled={!isController}
              title="รีเซ็ตสถานะโชว์"
            >
              <RotateCcw aria-hidden />
              รีเซ็ตสถานะโชว์
            </Button>
          )}
          {!state.begun && canEdit && (
            <p className="text-[13px] text-muted-foreground">เริ่มโชว์แล้ว ปุ่มจบโชว์และรีเซ็ตจะอยู่ตรงนี้</p>
          )}
          {lastRun && (
            <LastRunRecord
              seconds={lastRun.seconds}
              at={lastRun.at}
              onClear={canEdit ? clearLastRun : null}
              className="mt-2"
            />
          )}

          {/* Audio */}
          <h4 className="eyebrow key mb-2 mt-5">Audio</h4>
          {/* Landscape phone only: the NOW card drops its fade row there (spec §G.10,
              "everything else in the tools sheet"). Same condition as the card's. */}
          {current && (currentAudioUrl || (isController && state.begun)) && (
            <div className="mb-2.5 hidden grid-cols-[1.05fr_.72fr_1.25fr] gap-[3px] [@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:grid">
              {fadeKeys}
            </div>
          )}
          {current && (currentAudioUrl || (isController && state.begun)) ? (
            <div className="space-y-2.5">
              {/* scrubber — only when THIS device holds the audio file */}
              {currentAudioUrl && (
                <div className="flex min-w-0 items-center gap-2">
                  {/* status glyph only — play/pause is the dock's RUN / PAUSE key */}
                  <span
                    title={state.running ? "กำลังเล่น (คุมที่ปุ่มรันโชว์)" : "หยุดอยู่ (กดรันโชว์เพื่อเล่น)"}
                    className="flex size-8 shrink-0 items-center justify-center rounded-[2px] bg-foreground/10 text-foreground/80"
                  >
                    {state.running ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
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
                    className="min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="num shrink-0 text-right text-[13px]">
                    {playingId === current.id
                      ? `${fmtTime(audioCurrent)} / ${fmtTime(audioDuration)}`
                      : fmtTime(audioDuration)}
                  </span>
                </div>
              )}
              {/* per-track volume — set each track's level (in advance too). View-only
                  devices can see the level; only the controller sets it. */}
              <div className="flex min-w-0 items-center gap-2">
                <Volume1 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
                  className="min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="num w-11 shrink-0 text-right text-[13px]">{volumes[current.id] ?? 100}%</span>
              </div>
              {/* iOS hands back a READ-ONLY HTMLMediaElement.volume: the assignment is
                  accepted and does nothing, so the slider, the 3-second Auto Mute fade
                  and the MC duck all animate convincingly while the PA stays at full
                  level. Said only on the device that actually is the sound host. */}
              {volumeIsDead && soundOutput && (
                <p className="text-[12.5px] leading-snug text-warning-ink">
                  เครื่องนี้ (iPhone/iPad) ปรับ “ระดับเสียง” ในแอปไม่ได้ — สไลเดอร์กับปุ่มหรี่เสียงจะไม่มีผลจริง
                  ใช้ปุ่มเพิ่ม/ลดเสียงข้างเครื่อง หรือให้เครื่องอื่นเป็นตัวปล่อยเสียงแทน (ปุ่มปิดเสียงยังใช้ได้)
                </p>
              )}
              {currentAudioUrl ? (
                <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <Music2 aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{audioNames[current.id]}</span>
                </p>
              ) : currentBusy === "down" ? (
                // an online file exists; this device is fetching it
                <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
                  กำลังดาวน์โหลดเพลงจากคลาวด์…
                </p>
              ) : (
                // controller with no local file: the fades ride the speaker device's
                // volume by remote
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <Volume2 aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0">คุมเสียงของเครื่องที่เล่นไฟล์ (รีโมท)</span>
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openFilePicker(current.id)}
                    title="เปลี่ยน/อัปโหลดไฟล์เพลงสำหรับรายการนี้"
                    className="h-11 shrink-0 gap-1.5 px-3 text-[13px]"
                  >
                    <FolderOpen aria-hidden className="size-4" />
                    โหลดไฟล์ที่นี่
                  </Button>
                </div>
              )}
            </div>
          ) : current && (currentBusy === "down" || currentHasOnline) ? (
            // an online file exists for this item — it auto-downloads to this device
            <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
              กำลังเตรียมไฟล์เพลงจากคลาวด์…
            </p>
          ) : current ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => openFilePicker(current.id)}
              className="h-11 w-full justify-start gap-1.5 text-[14px]"
            >
              <FolderOpen aria-hidden className="size-4" />
              โหลดไฟล์เพลงสำหรับรายการนี้
            </Button>
          ) : null}

          {/* per-device playback options: crossfade (opt-in) + output routing
              (desktop-only picker). Defaults keep the old behaviour exactly. */}
          <button
            type="button"
            role="switch"
            aria-checked={crossfade}
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
            className="mt-2.5 flex h-11 w-full items-center justify-between rounded-[2px] px-3 text-[14px] hover:bg-muted"
          >
            <span className="flex items-center gap-2">
              <Volume1 aria-hidden className="size-4" />
              Crossfade
            </span>
            <span className={cn("font-semibold", crossfade ? "text-primary-ink" : "text-muted-foreground")}>
              {crossfade ? "เปิด" : "ปิด"}
            </span>
          </button>
          {/* The ONLY output picker on this screen: its effect resets the sink and
              toasts when a device vanishes, and two would toast twice. */}
          <AudioOutputPicker value={sinkId} onChange={setSinkId} />

          {/* pre-set the next track's volume — syncs to the speaker device so the
              crew can dial the next song's level before it even starts */}
          {next && (
            <div className="mt-3">
              <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <Volume1 aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">ตั้งความดังล่วงหน้า · {next.title || "—"}</span>
                </p>
                <span className="num shrink-0 text-[13px]">{volumes[next.id] ?? 100}%</span>
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
                className="w-full disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                {audioUrls[next.id] ? (
                  <>
                    <Music2 aria-hidden className="size-3.5 shrink-0" /> ไฟล์เพลงพร้อมบนเครื่องนี้
                  </>
                ) : audioBusy[next.id] === "down" || next.audio_path ? (
                  <>
                    <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" /> กำลังเตรียมไฟล์จากคลาวด์…
                  </>
                ) : (
                  <>
                    <FolderOpen aria-hidden className="size-3.5 shrink-0" /> ยังไม่ได้โหลดไฟล์เพลง
                  </>
                )}
              </p>
            </div>
          )}

          {/* Pre-flight readiness, in full: does THIS device hold every track's file? */}
          {audioItems.length > 0 && (
            <p
              className={cn(
                "mt-3 flex items-start gap-1.5 rounded-[2px] px-2.5 py-2 text-[13px] font-medium",
                allReady ? "bg-success/[.16] text-success-ink" : "bg-warning/[.16] text-warning-ink"
              )}
            >
              {allReady ? (
                <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
              ) : downloadingAudio ? (
                <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />
              ) : (
                <HardDriveDownload aria-hidden className="mt-0.5 size-4 shrink-0" />
              )}
              <span className="min-w-0">{readinessSentence}</span>
            </p>
          )}

          {/* Control */}
          <h4 className="eyebrow key mb-2 mt-5">Control</h4>
          <p className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium">
            {isController ? (
              <SlidersHorizontal aria-hidden className="size-4 shrink-0" />
            ) : (
              <Eye aria-hidden className="size-4 shrink-0" />
            )}
            <span className="min-w-0 truncate">
              {isController ? "เครื่องนี้กำลังคุมโชว์" : "ดูอย่างเดียว"}
              {toolsOpen && <span className="font-normal text-muted-foreground"> · {deviceLabel()}</span>}
            </span>
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {state.mode === "auto"
              ? "Auto: เปลี่ยนรายการเองเมื่อเพลงจบ — กด Manual เพื่อคุมเอง"
              : "Manual: กด NEXT เพื่อข้ามรายการ — ซิงค์หลายเครื่องอัตโนมัติ"}
          </p>
          <LiveFullscreenRow />
          {/* Dark | Light — the header that carried the theme switch is hidden here,
              and leaving a running show to find it goes through the leave guard. */}
          <div className="mt-2" data-testid="live-theme">
            <ThemeSeg />
          </div>
          {isController && (
            <p className="mt-2 hidden text-[12.5px] text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:block">
              คีย์ลัด: <kbd>Space</kbd> เริ่ม/รัน · <kbd>→</kbd>/<kbd>N</kbd> ถัดไป · <kbd>←</kbd> ย้อน
            </p>
          )}

          {/* Feedback — the floating button is gone, and a member mid-show still has
              to be able to report from the one screen they cannot leave. */}
          {userId && tenantId && (
            <>
              <h4 className="eyebrow key mb-2 mt-5">Feedback</h4>
              <FeedbackButton userId={userId} tenantId={tenantId} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One figure in the top bar (stage, landscape phone): a Thai label over a big
 *  numeral — 22 px beside the landscape phone's 25 px wall clock, 28 px at stage. */
function Stat({
  label,
  suppress,
  children,
}: {
  label: string;
  /** the value comes from the wall clock, so SSR and the client differ by a tick */
  suppress?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="text-right">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="num text-[22px] leading-none stage:text-[28px]" suppressHydrationWarning={suppress}>
        {children}
      </div>
    </div>
  );
}

/** The fullscreen switch for Live tools: the header that carries it elsewhere is
 *  hidden on this screen. Renders nothing where fullscreen cannot work (every
 *  iPhone, an installed app). */
function LiveFullscreenRow() {
  const { fs, available, toggle } = useFullscreen();
  if (!available) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={fs}
      onClick={toggle}
      className="mt-2 flex h-11 w-full items-center justify-between rounded-[2px] px-3 text-[14px] hover:bg-muted"
    >
      <span className="flex items-center gap-2">
        <Maximize aria-hidden className="size-4" />
        เต็มจอ
      </span>
      <span className={cn("font-semibold", fs ? "text-primary-ink" : "text-muted-foreground")}>
        {fs ? "เปิด" : "ปิด"}
      </span>
    </button>
  );
}

/** "เวลาโชว์ล่าสุด" — the run time จบโชว์ saved, with its own ล้าง (admins only). */
function LastRunRecord({
  seconds,
  at,
  onClear,
  className,
}: {
  seconds: number;
  at: number;
  onClear: (() => void) | null;
  className?: string;
}) {
  return (
    <div className={cn("slab flex items-center justify-between gap-2 px-4 py-3", className)}>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Timer aria-hidden className="size-3.5 shrink-0" /> เวลาโชว์ล่าสุด (บันทึกไว้)
        </p>
        <p className="num text-[22px] leading-tight">
          {formatDuration(seconds)}
          <span className="ml-2 font-sans text-[11px] font-normal text-muted-foreground">
            ·{" "}
            {/* timeZone pinned on purpose. lastRun is seeded from props in a
                useState initialiser, so this renders during SSR too — and the
                server is UTC, which printed a 21:30 finish as 14:30 (and the
                wrong DAY for anything before 07:00) until hydration replaced
                it. Every show this label runs is in Thailand, so Bangkok is
                the right answer on both sides and the mismatch disappears. */}
            {new Date(at).toLocaleString("th-TH", {
              timeZone: "Asia/Bangkok",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </p>
      </div>
      {onClear && (
        <Button
          variant="ghost"
          onClick={onClear}
          className="h-11 shrink-0 text-muted-foreground"
          title="ล้างเวลาโชว์ล่าสุดที่บันทึกไว้"
        >
          ล้าง
        </Button>
      )}
    </div>
  );
}
