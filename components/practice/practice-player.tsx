"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Play,
  Pause,
  Loader2,
  Gauge,
  Volume2,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  AudioLines,
  Search,
  MapPin,
  Plus,
  Repeat,
  Pencil,
  X,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { writeFailureMessage } from "@/lib/practice-journal-gate";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { getSongBlob } from "@/lib/song-cache";
import { getLocalSource, listLocalSourceIds } from "@/lib/local-source";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import { PracticeAudioEngine } from "@/lib/practice-audio";
import { detectBeats } from "@/lib/bpm-detect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BreakTimer } from "@/components/practice/break-timer";
import { Metronome } from "@/components/practice/metronome";
import { SetlistRunCard } from "@/components/practice/setlist-run-card";
import type { QueueEntry } from "@/lib/practice-setlist";
import { cn } from "@/lib/utils";
import { hasThai } from "@/lib/thai";
import { useSongCovers } from "@/lib/song-covers";
import { MARKER_PRESETS, type Song, type SongMarker, type PracticeSong } from "@/lib/types";

// Speed presets — slowing down for practice. The engine (SoundTouchJS) time-
// stretches with pitch preserved, so 0.5x stays in the same key, just slower —
// and it does so identically across browsers, including iOS Safari.
const SPEEDS = [1, 0.75, 0.5] as const;
// only auto-log a song as "practiced" once it's been played at least this long
const RUN_LOG_THRESHOLD = 20;

/**
 * The Thai sentence for a failed write here — the same one the สมุดซ้อม tab uses,
 * through the same helper (lib/practice-journal-gate.ts), because both halves of
 * this room fail the same way: `anon` holds no grants on song_markers /
 * practice_songs (0026 grants only to `authenticated`), so in the ~minute
 * supabase-js spends on the anon key after a failed token refresh every write
 * below comes back `permission denied for table song_markers`, 42501 — which used
 * to be printed verbatim, English SQL inside a Thai toast. That is the original
 * bug the gate was written to kill; it just stopped at the tab boundary.
 * Mirrors practice-journal.tsx's writeFailureNote deliberately: same shape, same
 * console line, so the two tabs cannot drift apart again.
 */
async function writeFailureNote(
  error: { code?: string | null; message?: string | null } | null | undefined
): Promise<string> {
  const live = await hasLiveSession();
  console.error(
    "[CueIQ] practice player write failed:",
    error?.code ?? "-",
    error?.message ?? "-"
  );
  return writeFailureMessage(error?.code, error?.message, live);
}

function mmss(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Practice Mode player — Slices 1 + 2 (+ auto-log from Slice 3). The room has a
 * curated PRACTICE LIST (a subset of the band's library) that any member OF THAT
 * BAND can manage — they practice on their own / at home; play a listed song slowed
 * down (1.0 / 0.75 / 0.5, pitch preserved) + scrubber; jump
 * between section markers (per-song, reusable; band-writable); loop a section with
 * Mark In→Mark Out; run a break timer. Songs played long enough are auto-logged to
 * practice_runs so the journal can show "what we practiced today". Single device,
 * online: audio streams from R2 on demand. For a timed run-through use Live Mode.
 */
export function PracticePlayer({
  roomName,
  eventId,
  groupId,
  currentUserId,
  songs,
  items,
  setItems,
  markers,
  setMarkers,
  canManage,
  canCurate,
  onRunLogged,
}: {
  /** shown under the now-playing title ("ห้องซ้อม — RED REVOLUTION · 1 / 5") */
  roomName?: string;
  eventId: string;
  groupId: string; // the band — "ซ้อมตามเซ็ตลิสต์" lists this band's shows
  currentUserId: string;
  songs: Song[]; // the band's full library — the pool the "add song" picker offers
  // The practice list lives in PracticeMode (the parent) so it SURVIVES a tab switch
  // — the player unmounts when you open the journal, and local state would reset to
  // a stale server prop, dropping songs you just added (and then the unique key
  // would reject re-adding them). Owning it above the Tabs fixes that.
  items: PracticeSong[];
  setItems: Dispatch<SetStateAction<PracticeSong[]>>;
  // Section markers live in the parent for the SAME reason — a marker added, then
  // hidden by a tab switch, used to vanish (and re-marking inserted a duplicate row).
  markers: Record<string, SongMarker[]>;
  setMarkers: Dispatch<SetStateAction<Record<string, SongMarker[]>>>;
  canManage: boolean; // Ar/admin — gates only the metronome's "save BPM to song"
  // (BPM lives on the guarded songs table)
  canCurate: boolean; // may edit THIS band's practice list + section markers
  onRunLogged?: () => void;
}) {
  const confirm = useConfirm();
  const songsById = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);
  // ⭐#1 step 7 — a song whose only copy is a file held on THIS device (an upload
  // queued at a venue with no wifi) is playable here, so it must not be filtered
  // out of the practice list as if it had no audio at all.
  const [localSongIds, setLocalSongIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listLocalSourceIds()
        // UNION, never replace: a successful flush uploads the bytes and then
        // clears the override, and the `songs` prop is a snapshot that will not
        // learn about the new master until this page is reloaded. Replacing would
        // make the song disappear from the practice list at the exact moment it
        // became available to everyone — on the device that uploaded it.
        .then((ids) => {
          if (alive) setLocalSongIds((prev) => new Set([...prev, ...ids]));
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, []);
  const playable = useCallback(
    (s: Song) => !!s.audio_path || localSongIds.has(s.id),
    [localSongIds]
  );
  // library songs that actually have audio — the pool the picker offers
  const library = useMemo(() => songs.filter(playable), [songs, playable]);
  const listedIds = useMemo(() => new Set(items.map((i) => i.song_id)), [items]);
  // resolve each list row to a playable song (skip songs that lost their audio)
  const practiceSongs = useMemo(
    () =>
      items
        .map((item) => ({ item, song: songsById.get(item.song_id) }))
        .filter(
          (x): x is { item: PracticeSong; song: Song } => !!x.song && playable(x.song)
        ),
    [items, songsById, playable]
  );

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return practiceSongs;
    return practiceSongs.filter((x) => x.song.title.toLowerCase().includes(q));
  }, [practiceSongs, query]);

  const engineRef = useRef<PracticeAudioEngine | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [vol, setVol] = useState(100);
  // true while the engine decodes a song for the first slow-down (stretch backend)
  const [preparing, setPreparing] = useState(false);

  const [editMarkers, setEditMarkers] = useState(false);
  const [customLabel, setCustomLabel] = useState("");

  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const loopRef = useRef<{ a: number | null; b: number | null; on: boolean }>({
    a: null,
    b: null,
    on: false,
  });
  loopRef.current = { a: loopA, b: loopB, on: loopOn };

  // "ซ้อมตามเซ็ตลิสต์": the queue being played through, and where in it we are.
  // While set, a song reaching its end starts the next one (see onEndedRef).
  const [run, setRun] = useState<{ showId: string; queue: QueueEntry[]; pos: number } | null>(
    null
  );
  const onEndedRef = useRef<() => void>(() => {});
  // Phone-only fold of the section-drilling tools (see the note at the fold).
  const [drillOpen, setDrillOpen] = useState(false);

  const current = currentId ? songsById.get(currentId) ?? null : null;
  // The Now Playing cover. The songs this room is handed come from the event bundle,
  // which leaves the cover pictures out (lib/song-columns.ts), so the room asks for the
  // ones it shows (lib/song-covers.ts: kept for the visit, shared with Live Mode).
  // Decoration only — a failed read just leaves the band tile.
  // The whole list is asked for at once (one read when the room opens), plus a song a
  // setlist run brought in from outside it.
  const covers = useSongCovers(
    useMemo(
      () => [...practiceSongs.map((x) => x.song.id), ...(currentId ? [currentId] : [])],
      [practiceSongs, currentId]
    )
  );
  const currentCover = current ? current.cover ?? covers[current.id] ?? null : null;
  const curMarkers = useMemo(
    () =>
      (currentId ? markers[currentId] ?? [] : [])
        .slice()
        .sort((a, b) => a.position_seconds - b.position_seconds),
    [markers, currentId]
  );
  // Never folded while it is in use: a song with markers, or a loop being set.
  const drillInUse = curMarkers.length > 0 || loopA != null || loopB != null || loopOn;
  const showDrill = drillOpen || drillInUse;
  // …and once opened by use it stays open: "ล้างทั้งหมด" on a song's markers used
  // to fold the tools away under the very tap that cleared them.
  useEffect(() => {
    if (drillInUse && !drillOpen) setDrillOpen(true);
  }, [drillInUse, drillOpen]);

  // --- auto-log accounting (refs so the stable audio listeners can mutate them) ---
  const runRef = useRef<{
    song: Song | null;
    accum: number; // played seconds accumulated
    startedAt: number | null; // ms when the current play burst began
    speed: number;
  }>({ song: null, accum: 0, startedAt: null, speed: 1 });
  runRef.current.speed = speed;

  function flushRun() {
    const r = runRef.current;
    if (r.startedAt != null) {
      r.accum += (Date.now() - r.startedAt) / 1000;
      r.startedAt = null;
    }
    const song = r.song;
    const secs = Math.round(r.accum);
    r.song = null;
    r.accum = 0;
    if (!song || secs < RUN_LOG_THRESHOLD) return;
    const supabase = createClient();
    supabase
      .from("practice_runs")
      .insert({
        tenant_id: song.tenant_id,
        group_id: song.group_id,
        event_id: eventId,
        song_id: song.id,
        song_title: song.title,
        seconds: secs,
        last_speed: r.speed,
        created_by: currentUserId,
      })
      .then(() => onRunLogged?.());
  }

  // one SoundTouch engine for the whole session (created once; talks to Web Audio)
  useEffect(() => {
    const engine = new PracticeAudioEngine();
    engineRef.current = engine;
    engine.onDuration = (d) => setDur(d);
    engine.onTime = (t) => {
      setCur(t);
      const { a: la, b: lb, on } = loopRef.current;
      if (on && la != null && lb != null && lb > la && t >= lb) engine.seek(la);
    };
    engine.onPlayingChange = (p) => {
      setPlaying(p);
      const r = runRef.current;
      if (p) {
        if (r.startedAt == null) r.startedAt = Date.now();
      } else if (r.startedAt != null) {
        r.accum += (Date.now() - r.startedAt) / 1000;
        r.startedAt = null;
      }
    };
    engine.onPreparing = (p) => setPreparing(p);
    // Through a ref: this effect runs once, and the run it must advance is state.
    engine.onEnded = () => onEndedRef.current();
    // The engine couldn't decode this song for slow-down and dropped back to 1×
    // native playback — follow it with the speed buttons so the UI isn't lying.
    engine.onStretchFailed = () => {
      setSpeed(1);
      toast.error("ปรับความเร็วไม่ได้กับเพลงนี้", {
        description: "ไฟล์นี้ถอดรหัสไม่ได้ — เล่นที่ความเร็วปกติแทน",
      });
    };
    return () => {
      flushRun(); // log whatever was playing when we leave
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setVolume(vol / 100);
  }, [vol]);

  const wakeRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!playing) {
      wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
      return;
    }
    navigator.wakeLock
      ?.request("screen")
      .then((wl) => {
        wl.addEventListener("release", () => {
          if (wakeRef.current === wl) wakeRef.current = null;
        });
        wakeRef.current = wl;
      })
      .catch(() => {});
    return () => {
      wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
    };
  }, [playing]);

  // Newest tap wins: each selectSong takes a token, and after every await a stale
  // call bails out — a slow download tapped FIRST must never tear down / override
  // the song the user picked LAST (nor zero its run accounting).
  const selectTokenRef = useRef(0);

  async function selectSong(song: Song, opts?: { fromRun?: boolean }) {
    const engine = engineRef.current;
    // A song with no online master is still playable when THIS device holds the
    // file (⭐#1 step 7) — the local-source read below is the one that finds it.
    if (!engine || !(song.audio_path || localSongIds.has(song.id))) return;
    engine.unlock(); // sync, inside the tap — unlocks audio on iOS Safari
    if (song.id === currentId) {
      engine.toggle(); // pausing mid-set is not leaving the set
      return;
    }
    // Picking some other song by hand leaves the setlist run behind.
    if (!opts?.fromRun) setRun(null);
    const token = ++selectTokenRef.current;
    flushRun(); // finalize the previous song's practice time
    setLoadingId(song.id);
    try {
      // Source order: a per-device local override (desktop "ใช้ไฟล์ในเครื่องนี้")
      // wins; otherwise cache-first — a prefetched song opens instantly, else
      // download once (and the cache keeps it for next time).
      const local = await getLocalSource(song.id);
      if (token !== selectTokenRef.current) return; // a newer tap took over
      // No master AND no local bytes left. This is the narrow window after the
      // upload queue flushed: the override is gone, the file IS online now, but
      // the `songs` snapshot this page was rendered from still says null — so we
      // have no key to fetch it with. Say so instead of leaving a dead tap.
      if (!local && !song.audio_path) {
        toast.info("ไฟล์เพิ่งอัปขึ้นคลังแล้ว", {
          description: "รีเฟรชหน้านี้อีกครั้งเพื่อเล่นจากคลัง",
        });
        return;
      }
      const blob = local?.blob ?? (await getSongBlob(song.audio_path!));
      if (token !== selectTokenRef.current) return;
      await engine.load(blob); // decode happens here, inside the spinner
      if (token !== selectTokenRef.current) return;
      setCurrentId(song.id);
      runRef.current.song = song; // start accounting for the new song
      runRef.current.accum = 0;
      runRef.current.startedAt = null;
      setLoopA(null);
      setLoopB(null);
      setLoopOn(false);
      setEditMarkers(false);
      await engine.play(); // engine already carries the current speed (tempo)
    } catch (err) {
      if (token !== selectTokenRef.current) return; // superseded — don't toast
      toast.error("โหลดเพลงไม่สำเร็จ", {
        description: err instanceof Error
          ? `${err.message}${opts?.fromRun ? " — หยุดเล่นตามเซ็ตไว้ก่อน" : ""}`
          : opts?.fromRun
          ? "หยุดเล่นตามเซ็ตไว้ก่อน"
          : undefined,
      });
      // A set whose next song never loaded must not keep claiming "กำลังเล่นเพลงที่
      // N": the previous song is still the loaded one, so replaying it and letting
      // it end would silently skip the song that failed.
      if (opts?.fromRun) setRun(null);
    } finally {
      // a stale call must not clear the spinner of the tap that superseded it
      if (token === selectTokenRef.current) setLoadingId(null);
    }
  }

  /** Start (or jump within) a setlist run at `index`. */
  function playFromRun(showId: string, queue: QueueEntry[], index: number) {
    const entry = queue[index];
    if (!entry) return;
    setRun({ showId, queue, pos: index });
    const engine = engineRef.current;
    if (engine && entry.song.id === currentId) {
      // already loaded — start it over rather than toggling it off. Clear an A-B
      // loop left from drilling it (onTime would keep seeking back and the song,
      // so the set, would never end), and take the select token so a hand-picked
      // song still downloading cannot land on top of the set afterwards.
      ++selectTokenRef.current;
      setLoadingId(null);
      loopRef.current = { a: null, b: null, on: false };
      setLoopA(null);
      setLoopB(null);
      setLoopOn(false);
      engine.unlock();
      engine.seek(0);
      void engine.play();
      return;
    }
    void selectSong(entry.song, { fromRun: true });
  }

  // Re-pointed every render so the once-registered engine.onEnded always sees the
  // current run and the current selectSong.
  onEndedRef.current = () => {
    if (!run) return;
    // A newer song is already on its way (a row tapped in the last seconds of
    // this one): the old song ending must not overrule that tap.
    if (loadingId) return;
    const next = run.pos + 1;
    if (next >= run.queue.length) {
      setRun(null);
      toast.success("ซ้อมครบทั้งเซ็ตแล้ว");
      return;
    }
    setRun({ ...run, pos: next });
    void selectSong(run.queue[next].song, { fromRun: true });
  };

  function togglePlay() {
    const engine = engineRef.current;
    if (!engine || !currentId) return;
    engine.unlock();
    engine.toggle();
  }

  function seek(to: number) {
    engineRef.current?.seek(to);
  }

  function jumpTo(pos: number) {
    const engine = engineRef.current;
    if (!engine) return;
    engine.unlock();
    engine.seek(pos);
    if (!engine.playing) void engine.play();
  }

  // Re-read a song's marks from the server after every mutation, so the list on
  // screen is the server's rows and not a local guess — another device (or an
  // earlier visit to this room) may hold marks this session never saw.
  async function refreshMarkers(songId: string) {
    const { data, error } = await createClient()
      .from("song_markers")
      .select("*")
      .eq("song_id", songId)
      .order("position_seconds", { ascending: true });
    if (error || !data) return; // a failed read must not blank the marks we have
    setMarkers((prev) => ({ ...prev, [songId]: data as SongMarker[] }));
  }

  async function addMarker(label: string) {
    const engine = engineRef.current;
    if (!current || !engine) return;
    const pos = engine.currentTime;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("song_markers")
      .insert({
        tenant_id: current.tenant_id,
        group_id: current.group_id,
        song_id: current.id,
        label,
        position_seconds: pos,
        sort_order: curMarkers.length,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มมาร์คไม่สำเร็จ", { description: await writeFailureNote(error) });
      return;
    }
    const m = data as SongMarker;
    setMarkers((prev) => ({ ...prev, [current.id]: [...(prev[current.id] ?? []), m] }));
    setCustomLabel("");
    toast.success(`มาร์ค “${label}” ที่ ${mmss(pos)}`);
    await refreshMarkers(current.id);
  }

  async function deleteMarker(id: string) {
    if (!current) return;
    const songId = current.id;
    const snapshot = markers[songId] ?? [];
    setMarkers((prev) => ({
      ...prev,
      [songId]: (prev[songId] ?? []).filter((m) => m.id !== id),
    }));
    const { data, error } = await createClient()
      .from("song_markers")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      toast.error("ลบท่อนไม่สำเร็จ", { description: await writeFailureNote(error) });
      setMarkers((prev) => ({ ...prev, [songId]: snapshot })); // revert
      return;
    }
    // 0 rows = the delete reached the server and removed nothing (RLS mismatch or
    // an anon-key fallback after a stale session) — the mark is still on the server,
    // so it must not stay gone on screen
    if (wroteNothing(data)) {
      toast.error("ลบท่อนไม่สำเร็จ", { description: await noRowsMessage() });
      setMarkers((prev) => ({ ...prev, [songId]: snapshot })); // revert
      return;
    }
    await refreshMarkers(songId);
  }

  // wipe every mark on the current song at once (optimistic, reverts on error)
  async function clearMarkers() {
    if (!current) return;
    const songId = current.id;
    const list = markers[songId] ?? [];
    if (list.length === 0) return;
    const ok = await confirm({
      title: "ล้างท่อนทั้งหมด?",
      description: "จะลบจุดท่อนทั้งหมดของเพลงนี้",
      confirmText: "ล้างทั้งหมด",
    });
    if (!ok) return;
    setMarkers((prev) => ({ ...prev, [songId]: [] }));
    setEditMarkers(false);
    // Delete by SONG, not by the ids we happen to be holding: the in-memory list
    // can be behind the server, and an id-list delete would report success while
    // leaving those rows behind (they'd reappear on the next load).
    const { data, error } = await createClient()
      .from("song_markers")
      .delete()
      .eq("song_id", songId)
      .select("id");
    if (error) {
      toast.error("ล้างท่อนไม่สำเร็จ", { description: await writeFailureNote(error) });
      setMarkers((prev) => ({ ...prev, [songId]: list })); // revert
      return;
    }
    // same anon-fallback / RLS-mismatch ambiguity as every other guarded delete here
    if (wroteNothing(data)) {
      toast.error("ล้างท่อนไม่สำเร็จ", { description: await noRowsMessage() });
      setMarkers((prev) => ({ ...prev, [songId]: list })); // revert
      return;
    }
    toast.success("ล้างท่อนทั้งหมดแล้ว");
    await refreshMarkers(songId);
  }

  function setA() {
    const engine = engineRef.current;
    if (!engine) return;
    const t = engine.currentTime;
    setLoopA(t);
    if (loopB != null && t >= loopB) setLoopB(null);
  }
  function setB() {
    const engine = engineRef.current;
    if (!engine) return;
    const t = engine.currentTime;
    if (loopA != null && t <= loopA) {
      toast.error("Mark Out ต้องอยู่หลัง Mark In");
      return;
    }
    setLoopB(t);
    setLoopOn(true);
  }
  function clearLoop() {
    setLoopA(null);
    setLoopB(null);
    setLoopOn(false);
  }

  // --- practice list: any member OF THIS BAND adds a library song / takes one out
  // (practice is a band activity — see practice_songs). A label-wide read-only
  // observer may watch the room but not curate it: canCurate gates the controls. ---
  async function addSong(song: Song) {
    const sort = items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 1;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("practice_songs")
      .insert({
        tenant_id: song.tenant_id,
        group_id: song.group_id,
        event_id: eventId,
        song_id: song.id,
        sort_order: sort,
        created_by: currentUserId,
      })
      .select("*")
      .single();
    if (error || !data) {
      // 23505 = already in the list (unique event_id+song_id) — not a real failure
      if (error?.code === "23505") {
        toast.info("เพลงนี้อยู่ในลิสต์ซ้อมอยู่แล้ว");
      } else {
        toast.error("เพิ่มเพลงไม่สำเร็จ", { description: await writeFailureNote(error) });
      }
      return;
    }
    setItems((prev) =>
      prev.some((i) => i.id === (data as PracticeSong).id)
        ? prev
        : [...prev, data as PracticeSong]
    );
    toast.success(`เพิ่ม “${song.title}” เข้าลิสต์ซ้อม`);
  }

  async function removeSong(itemId: string) {
    const snapshot = items;
    const it = snapshot.find((i) => i.id === itemId);
    const title = it ? songsById.get(it.song_id)?.title : undefined;
    const ok = await confirm({
      title: "เอาเพลงออกจากลิสต์ซ้อม?",
      description: title ? `“${title}” จะถูกเอาออกจากลิสต์ซ้อม` : "เพลงนี้จะถูกเอาออกจากลิสต์ซ้อม",
      confirmText: "เอาออก",
    });
    if (!ok) return;
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    const { data, error } = await createClient()
      .from("practice_songs")
      .delete()
      .eq("id", itemId)
      .select("id");
    if (error) {
      toast.error("เอาเพลงออกไม่สำเร็จ", { description: await writeFailureNote(error) });
      setItems(snapshot);
      return;
    }
    // 0 rows = removed nothing on the server (RLS mismatch or a stale-session anon
    // fallback) — the song is still in everyone else's list, so it must not vanish
    // from just this screen
    if (wroteNothing(data)) {
      toast.error("เอาเพลงออกไม่สำเร็จ", { description: await noRowsMessage() });
      setItems(snapshot);
    }
  }

  // --- presentation only: where the hero says we are, and the transport's song
  // steps. Every step goes through selectSong / playFromRun / seek above, so the
  // audio, the run and the iOS unlock behave exactly as a row tap does. ---
  const listPos = currentId ? practiceSongs.findIndex((x) => x.song.id === currentId) : -1;
  const queuePos = run ? run.pos : listPos;
  const queueLen = run ? run.queue.length : practiceSongs.length;
  const canNext =
    !!current &&
    (run ? run.pos + 1 < run.queue.length : listPos >= 0 && listPos + 1 < practiceSongs.length);
  /** ⏮: back to the top of the song a few seconds in, else the song before it */
  function stepBack() {
    if (!current) return;
    if (cur > 3) {
      seek(0);
      return;
    }
    if (run && run.pos > 0) playFromRun(run.showId, run.queue, run.pos - 1);
    else if (!run && listPos > 0) void selectSong(practiceSongs[listPos - 1].song);
    else seek(0);
  }
  /** ⏭: the next song of the set being run, else the next one on the list */
  function stepNext() {
    if (!canNext) return;
    if (run) playFromRun(run.showId, run.queue, run.pos + 1);
    else void selectSong(practiceSongs[listPos + 1].song);
  }
  // The section the playhead is in: the last mark at or before it.
  let activeMarkerId: string | null = null;
  for (const m of curMarkers) if (m.position_seconds <= cur + 0.25) activeMarkerId = m.id;
  const at = (t: number) => `${dur > 0 ? Math.min(100, Math.max(0, (t / dur) * 100)) : 0}%`;
  // a loop end reads as its section's name when it sits on a mark ("วน Hook → Bridge")
  const pointLabel = (t: number) =>
    curMarkers.find((m) => Math.abs(m.position_seconds - t) < 0.75)?.label ?? mmss(t);
  const presetLabel = (label: string) => (MARKER_PRESETS as readonly string[]).includes(label);

  return (
    <div className="space-y-3">
      {/* Now Playing — the room's one lit hero (spec §G.6). */}
      <section
        aria-label="Now playing"
        className="lit cut sweep p-4"
        style={{ "--cut": "22px" } as CSSProperties}
      >
        <div className="flex items-center gap-3.5">
          {currentCover ? (
            // the song's own cover (songs.cover, 0044) — a 192 px data URL, so 84 px
            // stays sharp on a 2x screen
            // eslint-disable-next-line @next/next/no-img-element -- data-URL thumbnail: next/image adds nothing
            <img
              src={currentCover}
              alt=""
              aria-hidden
              className="h-[84px] w-[84px] flex-none rounded-[2px] bg-muted object-cover"
            />
          ) : (
            /* band cover: the fill under a soft white top highlight (spec v3 §G.6 —
               v2's hard 60° wedge is gone with the rest of the wedge language) */
            <span
              aria-hidden
              className="grid h-[84px] w-[84px] flex-none place-items-center rounded-[2px] text-primary-foreground"
              style={{
                background:
                  "radial-gradient(120% 80% at 50% 0%, hsl(0 0% 100% / .24), transparent 64%), hsl(var(--primary))",
              }}
            >
              <AudioLines className="h-[38px] w-[38px]" strokeWidth={2.4} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="eyebrow key">Now Playing</div>
            {/* .95 leading is Barlow's; a Thai title needs room for its tone marks,
                which the 2-line clamp's overflow would otherwise shave off */}
            <div
              className={cn(
                "disp clamp-2 mt-1",
                current && hasThai(current.title)
                  ? "text-[28px] font-bold leading-[1.3]"
                  : "text-[34px] leading-[.95]"
              )}
            >
              {current ? current.title : "—"}
            </div>
            <div className="mt-1 truncate text-[12.5px] text-muted-foreground">
              {roomName ?? "ห้องซ้อม"}
              {current && queuePos >= 0 && (
                <>
                  {" · "}
                  <span className="num text-[15px]">
                    {queuePos + 1} / {queueLen}
                  </span>
                </>
              )}
            </div>
            {current && speed !== 1 && (
              <Badge variant="warning" className="mt-1.5">
                <Gauge aria-hidden />
                ช้า <span className="num text-[14px]">{speed}×</span> · คีย์เดิม
              </Badge>
            )}
          </div>
        </div>

        {current ? (
          <>
            {/* section marks: tap to jump; the one the playhead is in is solid. In
                edit mode each chip carries its own 44 × 44 delete key (instant, and
                the marks are the song's, so every room loses it): the key stands 3 px
                off its chip and the next chip a wider 8 px off the key. */}
            {curMarkers.length > 0 && (
              <div
                role="group"
                aria-label="ท่อนเพลง"
                className={cn(
                  "no-scrollbar -mx-4 mt-4 flex overflow-x-auto px-4 [mask-image:linear-gradient(90deg,#000_85%,transparent)]",
                  canCurate && editMarkers ? "gap-2" : "gap-[3px]"
                )}
              >
                {curMarkers.map((m) => (
                  <span key={m.id} className="flex shrink-0 gap-[3px]">
                    <button
                      type="button"
                      onClick={() => jumpTo(m.position_seconds)}
                      aria-pressed={m.id === activeMarkerId}
                      title={`ไปที่ ${m.label} (${mmss(m.position_seconds)})`}
                      className={cn(
                        "chip chip-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        // presets are English chrome; a typed label stays as typed
                        presetLabel(m.label) && "en",
                        m.id === activeMarkerId ? "chip-solid" : "chip-neutral"
                      )}
                    >
                      {m.label}
                      <span className="num text-[13px] opacity-70">{mmss(m.position_seconds)}</span>
                    </button>
                    {canCurate && editMarkers && (
                      <button
                        type="button"
                        onClick={() => deleteMarker(m.id)}
                        aria-label={`ลบท่อน ${m.label}`}
                        title="ลบท่อนนี้"
                        className="grid h-11 w-11 place-items-center rounded-[2px] text-destructive hover:bg-destructive/10"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {/* scrubber: the native range (stage.css), with the A–B loop band and
                the section ticks drawn on the track under it */}
            <div className="relative mt-4">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-[4px] top-1/2 h-4 -translate-y-1/2"
              >
                {loopA != null && dur > 0 && (
                  <i
                    className="absolute top-[5px] h-[6px] bg-primary/30"
                    style={{
                      left: at(loopA),
                      width: `calc(${at(loopB ?? dur)} - ${at(loopA)})`,
                    }}
                  />
                )}
                {curMarkers.map((m) => (
                  <i
                    key={m.id}
                    className="absolute top-0 h-4 w-[2px] -translate-x-1/2 bg-foreground/40"
                    style={{ left: at(m.position_seconds) }}
                  />
                ))}
              </div>
              <input
                type="range"
                aria-label="ตำแหน่งในเพลง"
                min={0}
                max={dur || 0}
                step={0.1}
                value={cur}
                onChange={(e) => seek(Number(e.target.value))}
                className="relative w-full"
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
              <span className="num text-[16px] text-foreground">{mmss(cur)}</span>
              {loopA != null && loopB != null && (
                <span className="flex min-w-0 items-center gap-1 truncate">
                  <Repeat className="h-[13px] w-[13px] shrink-0" strokeWidth={2.2} aria-hidden />
                  วน {pointLabel(loopA)} → {pointLabel(loopB)}
                  {!loopOn && " (ปิดอยู่)"}
                </span>
              )}
              <span className="num text-[16px]">{mmss(dur)}</span>
            </div>

            {/* transport: −5s · ⏮ · PLAY (the chamfered key) · ⏭ · +5s */}
            <div className="mt-2 flex items-center justify-between px-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="ย้อน 5 วินาที"
                className="text-muted-foreground"
                onClick={() => seek(cur - 5)}
              >
                <span className="relative grid place-items-center">
                  <RotateCcw className="h-6 w-6" aria-hidden />
                  <span className="num absolute text-[9px] leading-none">5</span>
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="กลับต้นเพลง / เพลงก่อนหน้า"
                onClick={stepBack}
              >
                <SkipBack className="h-[26px] w-[26px]" strokeWidth={2.2} aria-hidden />
              </Button>
              <Button
                aria-label={playing ? "หยุดชั่วคราว" : "เล่น"}
                className="cut h-[72px] w-[72px] px-0 [--cut:14px]"
                onClick={togglePlay}
              >
                {playing ? (
                  <Pause className="h-[30px] w-[30px]" strokeWidth={2.4} aria-hidden />
                ) : (
                  <Play className="h-[30px] w-[30px]" strokeWidth={2.4} aria-hidden />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="เพลงถัดไป"
                disabled={!canNext}
                onClick={stepNext}
              >
                <SkipForward className="h-[26px] w-[26px]" strokeWidth={2.2} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="ข้ามไป 5 วินาที"
                className="text-muted-foreground"
                onClick={() => seek(cur + 5)}
              >
                <span className="relative grid place-items-center">
                  <RotateCw className="h-6 w-6" aria-hidden />
                  <span className="num absolute text-[9px] leading-none">5</span>
                </span>
              </Button>
            </div>

            {/* speed (pitch held) + the song's own volume */}
            <div className="mt-3 flex items-center gap-2">
              <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div role="group" aria-label="ความเร็ว" className="seg min-w-0 flex-1">
                {[...SPEEDS]
                  .sort((a, b) => a - b)
                  .map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={preparing}
                      aria-pressed={speed === s}
                      onClick={() => {
                        setSpeed(s);
                        engineRef.current?.unlock();
                        engineRef.current?.setTempo(s);
                      }}
                      className={cn(
                        "num !text-[15px] font-bold [font-family:var(--font-num)] transition-colors duration-2 disabled:opacity-50",
                        speed === s && "on"
                      )}
                    >
                      {s}×
                    </button>
                  ))}
              </div>
              {preparing && (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="w-16 shrink-0 text-[12.5px] text-muted-foreground">เสียงเพลง</span>
              <input
                type="range"
                aria-label="เสียงเพลง"
                min={0}
                max={100}
                value={vol}
                onChange={(e) => setVol(Number(e.target.value))}
                className="w-full"
              />
            </div>

            {/* Section drilling (A-B loop + markers), folded on a PHONE until asked
                for. Measured 2026-09-28: 0 markers and 0 slowed runs in 96 logged
                practice runs — the band plays songs and sets straight through — yet
                on a phone these two blocks were ~250px between the song playing and
                the set list saying what comes next. Open by itself whenever the song
                has markers or a loop is set; from sm up always open, as before. */}
            {!showDrill && (
              <button
                type="button"
                onClick={() => setDrillOpen(true)}
                className="mt-3 flex h-11 w-full items-center justify-center gap-1.5 border-t border-foreground/10 text-[13px] font-medium text-muted-foreground hover:text-foreground sm:hidden"
              >
                <Repeat className="h-4 w-4" aria-hidden /> วนท่อน / ท่อนเพลง
                <ChevronDown className="h-4 w-4" aria-hidden />
              </button>
            )}
            <div className={showDrill ? "" : "hidden sm:block"}>
              {/* A-B loop */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-3">
                <span className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground">
                  <Repeat className="h-4 w-4" aria-hidden /> วนท่อน
                </span>
                <Button
                  variant={loopA != null ? "outline" : "secondary"}
                  size="sm"
                  className="h-11 [@media(pointer:fine)]:h-9"
                  onClick={setA}
                >
                  <span className="en text-[14px]">Mark In</span>
                  {loopA != null && <span className="num text-[14px]">{mmss(loopA)}</span>}
                </Button>
                <Button
                  variant={loopB != null ? "outline" : "secondary"}
                  size="sm"
                  className="h-11 [@media(pointer:fine)]:h-9"
                  onClick={setB}
                >
                  <span className="en text-[14px]">Mark Out</span>
                  {loopB != null && <span className="num text-[14px]">{mmss(loopB)}</span>}
                </Button>
                <Button
                  variant={loopOn ? "default" : "secondary"}
                  size="sm"
                  className="h-11 [@media(pointer:fine)]:h-9"
                  aria-pressed={loopOn}
                  disabled={loopA == null || loopB == null}
                  onClick={() => setLoopOn((v) => !v)}
                >
                  <Repeat className="h-4 w-4" /> {loopOn ? "กำลังวน" : "วน"}
                </Button>
                {(loopA != null || loopB != null) && (
                  <Button variant="ghost" size="sm" className="h-11 [@media(pointer:fine)]:h-9" onClick={clearLoop}>
                    ล้าง
                  </Button>
                )}
              </div>

              {/* markers: the chips above jump; adding and removing lives here */}
              <div className="mt-3 border-t border-foreground/10 pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground">
                    <MapPin className="h-4 w-4" aria-hidden /> ท่อนเพลง
                    {curMarkers.length > 0 && (
                      <span className="num text-[14px]">{curMarkers.length}</span>
                    )}
                  </span>
                  {canCurate && curMarkers.length > 0 && (
                    <div className="flex items-center gap-1">
                      {editMarkers && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-11 [@media(pointer:fine)]:h-9 [&_svg]:text-destructive"
                          onClick={clearMarkers}
                        >
                          <Trash2 className="h-4 w-4" /> ล้างทั้งหมด
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 [@media(pointer:fine)]:h-9"
                        aria-pressed={editMarkers}
                        onClick={() => setEditMarkers((v) => !v)}
                      >
                        <Pencil className="h-4 w-4" /> {editMarkers ? "เสร็จ" : "แก้ไข"}
                      </Button>
                    </div>
                  )}
                </div>

                {curMarkers.length === 0 && (
                  <p className="text-[12.5px] text-muted-foreground">
                    {canCurate ? "ยังไม่มีท่อน — เพิ่มจากปุ่มด้านล่าง" : "ยังไม่มีท่อน"}
                  </p>
                )}

                {canCurate && (
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {MARKER_PRESETS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => addMarker(p)}
                          className="chip chip-lg chip-neutral en hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <Plus aria-hidden />
                          {p}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={customLabel}
                        onChange={(e) => setCustomLabel(e.target.value)}
                        aria-label="ชื่อท่อนเอง"
                        className="min-w-0"
                        placeholder={`ชื่อท่อนเอง แล้วเพิ่มที่ ${mmss(cur)}`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && customLabel.trim()) addMarker(customLabel.trim());
                        }}
                      />
                      <Button
                        variant="secondary"
                        disabled={!customLabel.trim()}
                        onClick={() => addMarker(customLabel.trim())}
                      >
                        <Plus className="h-4 w-4" /> เพิ่ม
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-[13px] text-muted-foreground">
            ยังไม่ได้เลือกเพลง — แตะเพลงด้านล่าง หรือกด “เล่นทั้งเซ็ต” เพื่อเริ่มซ้อม
          </p>
        )}
      </section>

      {/* practice tools: closed they are two keys; open, each is its own slab */}
      <div className="flex flex-wrap items-start gap-2">
        <Metronome
          song={current}
          canManage={canManage}
          playing={playing}
          position={cur}
          speed={speed}
          onDetectBeats={async () => {
            const buf = await engineRef.current?.getBuffer();
            return buf ? detectBeats(buf) : null;
          }}
        />
        <BreakTimer />
      </div>

      <SetlistRunCard
        groupId={groupId}
        songsById={songsById}
        playable={playable}
        running={
          run ? { showId: run.showId, index: run.pos, total: run.queue.length } : null
        }
        loadingSongId={loadingId}
        onPlay={playFromRun}
        onStop={() => setRun(null)}
      />

      {/* Practice list — only the songs chosen for this room. Any band member
          curates it (add from library / take out) and plays. For a timed run-through
          of the whole show, use Live Mode instead. */}
      <section aria-label="Queue" className="space-y-2.5">
        {/* The one Add to Queue picker lives here, at the same place in the tree
            whether the list is empty or not: it keeps its own open state, so a copy
            inside either branch below would close mid-choice the moment the first
            song (this phone's pick, or another phone's) flips the list. */}
        <div className="flex items-center justify-between gap-3 px-0.5">
          <h2 className="h2">Queue</h2>
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              ลิสต์ซ้อม
              {practiceSongs.length > 0 && (
                <>
                  {" · "}
                  <span className="num text-[15px] text-foreground">{practiceSongs.length}</span> เพลง
                </>
              )}
            </span>
            {canCurate && (
              <AddPracticeSongDialog library={library} listedIds={listedIds} onAdd={addSong} />
            )}
          </div>
        </div>

        {practiceSongs.length === 0 ? (
          <div className="slab px-4 py-10 text-center text-sm text-muted-foreground">
            <p>
              ยังไม่มีเพลงในลิสต์ซ้อม
              <br />
              {canCurate
                ? "กด “เพิ่มเพลง” เพื่อเลือกเพลงจากคลังมาซ้อม"
                : "วงนี้ยังไม่ได้เลือกเพลงมาซ้อม"}
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                aria-label="ค้นหาเพลงในลิสต์ซ้อม"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาเพลงในลิสต์ซ้อม..."
                className="pl-10"
              />
            </div>

            <div className="stack">
              {filtered.map(({ item, song: s }) => {
                const active = s.id === currentId;
                const loading = s.id === loadingId;
                const mCount = (markers[s.id] ?? []).length;
                const n = practiceSongs.findIndex((x) => x.item.id === item.id) + 1;
                return (
                  <div
                    key={item.id}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "slab flex min-h-[50px] items-center gap-1 pr-1",
                      active &&
                        "bg-[linear-gradient(90deg,hsl(var(--primary)/.14),transparent_70%)] shadow-[inset_4px_0_0_hsl(var(--primary)),inset_0_0_0_1px_hsl(var(--border))]"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectSong(s)}
                      className="flex min-h-[50px] min-w-0 flex-1 items-center gap-3 rounded-[2px] pl-3 pr-2 text-left transition-colors duration-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="grid w-5 shrink-0 place-items-center">
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : active && playing ? (
                          <AudioLines className="h-4 w-4 text-primary-ink" strokeWidth={2.8} aria-hidden />
                        ) : (
                          <span className="num text-[14px] text-faint">{n}</span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[14.5px]",
                          active ? "font-semibold text-primary-ink" : "font-medium"
                        )}
                      >
                        {s.title}
                      </span>
                      {mCount > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-muted-foreground">
                          <MapPin className="h-3.5 w-3.5" aria-hidden />
                          <span className="num text-[14px]">{mCount}</span>
                        </span>
                      )}
                      {s.duration_seconds > 0 && (
                        <span className="num shrink-0 text-[16px]">{mmss(s.duration_seconds)}</span>
                      )}
                    </button>
                    {canCurate && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeSong(item.id)}
                        title="เอาออกจากลิสต์ซ้อม"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="slab px-3 py-6 text-center text-sm text-muted-foreground">
                  ไม่พบเพลงที่ค้นหา
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// Pick a library song (with audio, not already in the list) to add to the practice
// list. Stays open after a pick so several songs can be added in one go.
function AddPracticeSongDialog({
  library,
  listedIds,
  onAdd,
}: {
  library: Song[];
  listedIds: Set<string>;
  onAdd: (song: Song) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const available = useMemo(
    () => library.filter((s) => !listedIds.has(s.id)),
    [library, listedIds]
  );
  const filtered = available.filter((s) =>
    s.title.toLowerCase().includes(q.trim().toLowerCase())
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" className="shrink-0">
          <Plus className="h-4 w-4" /> เพิ่มเพลง
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Queue</DialogTitle>
          <DialogDescription>เลือกเพลงจากคลังมาใส่ลิสต์ซ้อม — เลือกต่อได้หลายเพลง</DialogDescription>
        </DialogHeader>
        {library.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่มีเพลงที่มีไฟล์เสียงในคลังของวงนี้ — อัปโหลดในคลังเพลงก่อน แล้วกลับมาเพิ่มได้
          </p>
        ) : available.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            เพิ่มครบทุกเพลงในคลังแล้ว
          </p>
        ) : (
          <div className="space-y-2">
            <Input
              autoFocus
              type="search"
              aria-label="ค้นหาชื่อเพลง"
              placeholder="ค้นหาชื่อเพลง…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="stack max-h-72 overflow-auto">
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">ไม่พบเพลง</p>
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="slab flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-[15px] transition-colors duration-2 hover:bg-muted"
                    onClick={() => {
                      onAdd(s);
                      setQ("");
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate font-medium">{s.title}</span>
                    </span>
                    <span className="num shrink-0 text-[15px] text-muted-foreground">
                      {s.duration_seconds ? mmss(s.duration_seconds) : "—"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
