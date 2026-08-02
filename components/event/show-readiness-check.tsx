"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Download,
  ShieldCheck,
  HardDrive,
  BatteryMedium,
  Speaker,
  Wifi,
  WifiOff,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { loadAudioSink } from "@/components/event/audio-output-picker";
import { prefetchEventAudio, type PrefetchTarget } from "@/lib/audio-prefetch";
import { listLocalSourceIds } from "@/lib/local-source";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import type { LocalOnlyCandidate } from "@/lib/audio-targets";
import {
  getShowReadiness,
  requestPersist,
  formatBytes,
  type ShowReadiness,
} from "@/lib/show-readiness";

type RowTone = "ok" | "warn" | "bad" | "muted";

// Warn when free space drops under this — a full WAV master can be ~30–90 MB and a
// device that can't fit the next download could fail mid-prep.
const LOW_SPACE_BYTES = 500 * 1024 * 1024; // 500 MB
const LOW_BATTERY = 0.3; // 30%

function ToneIcon({ tone }: { tone: RowTone }) {
  if (tone === "ok") return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (tone === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (tone === "bad") return <XCircle className="h-4 w-4 text-destructive" />;
  return <span className="h-4 w-4" />;
}

function Row({
  tone,
  icon,
  label,
  value,
  action,
}: {
  tone: RowTone;
  icon: React.ReactNode;
  label: string;
  value: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-foreground">{label}</span>
      <span
        className={cn(
          "ml-auto inline-flex items-center gap-1.5 tabular-nums",
          tone === "ok" && "text-green-700 dark:text-green-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "bad" && "text-destructive",
          tone === "muted" && "text-muted-foreground"
        )}
      >
        {value}
        <ToneIcon tone={tone} />
      </span>
      {action}
    </div>
  );
}

/**
 * Show Readiness Check — the preflight an operator runs before "เริ่มโชว์", so a
 * device is provably ready to run the set OFFLINE (the offline-first foundation:
 * audio must be on-device and pinned before net even matters). One green/red
 * checklist: songs cached at the current version · storage pinned (won't be
 * evicted) · free space · battery · network. Inline actions fix the common gaps
 * (prep the device, pin storage) without leaving the page.
 *
 * Collapses to a one-line verdict when all-clear; auto-expands when something
 * blocks an offline run (missing/outdated audio).
 */
export function ShowReadinessCheck({
  eventId,
  targets,
  localOnly = [],
}: {
  eventId: string;
  targets: PrefetchTarget[];
  /**
   * Rows linked to a song with no online master (lib/audio-targets.ts). They are
   * not prefetch targets — there is nothing to download — but they are not nothing
   * either: either this device holds the file (⭐#1 step 7) or that row goes SILENT
   * on stage. Before this, they were invisible here, so a set with a fileless song
   * reported a clean green "พร้อมโชว์ออฟไลน์".
   */
  localOnly?: LocalOnlyCandidate[];
}) {
  const [r, setR] = useState<ShowReadiness | null>(null);
  const [open, setOpen] = useState(false);
  const userToggled = useRef(false); // once the user opens/closes, stop auto-driving it
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  // "หยุด" aborts the transfer in flight (not just between files) — on a
  // black-holed venue network the current download would otherwise never settle.
  const abortRef = useRef<AbortController | null>(null);
  // Desktop-only extras (the standalone show machine): which output the show
  // audio is pinned to, and whether this event's data is cached for an offline
  // cold boot. Both stay null on the web build → the rows never render there.
  const isDesktop =
    typeof window !== "undefined" &&
    !!(window as { cueiqNative?: unknown }).cueiqNative;
  const [sink, setSink] = useState<{ label: string; missing: boolean } | null>(null);
  const [offlineData, setOfflineData] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const check = async () => {
      // same key the desktop read-cache writes (desktop/src/data/cache.ts)
      try {
        setOfflineData(localStorage.getItem(`cueiq:cache:event:${eventId}`) != null);
      } catch {
        setOfflineData(null);
      }
      const saved = loadAudioSink();
      if (!saved) {
        if (alive) setSink({ label: "ลำโพงเริ่มต้นของระบบ", missing: false });
        return;
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const dev = all.find((d) => d.kind === "audiooutput" && d.deviceId === saved);
        if (alive)
          setSink(
            dev
              ? { label: dev.label || "อุปกรณ์เสียงที่เลือกไว้", missing: false }
              : { label: "อุปกรณ์ที่เลือกไว้ไม่ได้เสียบอยู่", missing: true }
          );
      } catch {
        if (alive) setSink(null);
      }
    };
    check();
    navigator.mediaDevices?.addEventListener?.("devicechange", check);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", check);
    };
  }, [isDesktop, eventId]);

  // Of the master-less rows, how many does THIS device actually hold bytes for?
  // The rest have no audio anywhere and will be silent — the one thing this
  // preflight exists to say out loud.
  const [heldLocally, setHeldLocally] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    getShowReadiness(eventId, targets)
      .then(setR)
      .catch(() => {});
    if (localOnly.length > 0) {
      listLocalSourceIds()
        // UNION, never replace. A successful flush uploads the file and then
        // CLEARS the local override, so a plain replace would drop the song out
        // of "held here" and re-file it under "no file anywhere" — flipping the
        // preflight to red for the one song that just got fixed, because
        // `localOnly` is a snapshot of the bundle and cannot know the master
        // landed. Bytes here OR bytes we promoted both mean playable.
        .then((ids) => setHeldLocally((prev) => new Set([...prev, ...ids])))
        .catch(() => {});
    }
  }, [eventId, targets, localOnly.length]);

  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    // a file picked in the Library changes this answer without a reload
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, [refresh]);

  // Auto-open the first time something is actually wrong — but never override a
  // choice the user already made. Keyed on BOTH failure halves: this used to live
  // inside the readiness callback, which only ever saw the download counts, so a
  // set whose ONLY problem was a song with no file at all stayed collapsed —
  // hiding the very row that names those songs.
  const needCount = r ? r.audio.stale + r.audio.missing : 0;
  const missingFileCount = localOnly.filter((c) => !heldLocally.has(c.songId)).length;
  useEffect(() => {
    if (!r || userToggled.current) return;
    setOpen(needCount > 0 || missingFileCount > 0);
  }, [r, needCount, missingFileCount]);

  const prepare = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      await prefetchEventAudio(eventId, targets, {
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
        isCancelled: () => ac.signal.aborted,
        signal: ac.signal,
      });
    } finally {
      // Leave the busy state however the prepare ended (cancel, timeout, throw):
      // a spinner that never clears dead-locks "เตรียม" — and with it the only way
      // to get the show's audio onto this device — for the rest of the session.
      abortRef.current = null;
      setProgress(null);
      setBusy(false);
      refresh();
    }
  }, [eventId, targets, refresh]);

  // Left the Show Runner while เตรียมเพลง was still running: nothing is watching
  // the progress any more, so stop the transfer instead of leaving its fetch,
  // stall timer and retry backoff alive behind the unmounted screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pin = useCallback(async () => {
    setPinBusy(true);
    await requestPersist();
    setPinBusy(false);
    refresh();
  }, [refresh]);

  // No audio in this event → nothing to preflight (e.g. an MC-only run).
  if (targets.length === 0 && localOnly.length === 0) return null;
  if (!r) return null;

  // Master-less rows split in two: bytes on this device (playable) vs no audio
  // anywhere (silent on stage). Only the second kind is a problem, and no amount
  // of "เตรียม" fixes it — somebody has to put a file on the song. Counted per
  // SONG, not per row: the same song can sit in a setlist twice and it is one
  // file either way.
  const bySong = (cs: LocalOnlyCandidate[]) => {
    const seen = new Map<string, LocalOnlyCandidate>();
    for (const c of cs) if (!seen.has(c.songId)) seen.set(c.songId, c);
    return [...seen.values()];
  };
  const localReady = bySong(localOnly.filter((c) => heldLocally.has(c.songId)));
  const noFileAtAll = bySong(localOnly.filter((c) => !heldLocally.has(c.songId)));
  const audioReady =
    r.audio.total + localReady.length > 0 && needCount === 0 && noFileAtAll.length === 0;

  // Critical = audio not all on-device at the current version (blocks offline run).
  // Warnings = won't stop the show but worth fixing: storage not pinned, low space,
  // low battery. Network being offline is EXPECTED for a standalone show → info only.
  const lowSpace = r.storage.free != null && r.storage.free < LOW_SPACE_BYTES;
  const notPinned = r.storage.persisted === false;
  const lowBattery =
    r.battery.supported &&
    r.battery.level != null &&
    r.battery.level < LOW_BATTERY &&
    !r.battery.charging;
  const hasWarn =
    lowSpace ||
    notPinned ||
    lowBattery ||
    (sink?.missing ?? false) ||
    offlineData === false;

  const verdict: RowTone = !audioReady ? "bad" : hasWarn ? "warn" : "ok";
  const verdictText = noFileAtAll.length
    ? `ยังไม่พร้อม — มี ${noFileAtAll.length} เพลงที่ยังไม่มีไฟล์`
    : !audioReady
      ? "ยังไม่พร้อม — เพลงยังไม่ครบในเครื่อง"
      : hasWarn
        ? "พร้อมโชว์ (มีข้อควรระวัง)"
        : "พร้อมโชว์ออฟไลน์";

  const toggle = () => {
    userToggled.current = true;
    setOpen((o) => !o);
  };

  return (
    <div
      className={cn(
        "no-print rounded-lg border bg-card/40",
        verdict === "bad" && "border-destructive/40",
        verdict === "warn" && "border-amber-500/40"
      )}
    >
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">ตรวจความพร้อมก่อนเริ่มโชว์</span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 text-sm font-medium",
            verdict === "ok" && "text-green-700 dark:text-green-400",
            verdict === "warn" && "text-amber-600 dark:text-amber-400",
            verdict === "bad" && "text-destructive"
          )}
        >
          <ToneIcon tone={verdict} />
          {verdictText}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-0.5 border-t px-3 py-2">
          <Row
            tone={audioReady ? "ok" : needCount > 0 ? "bad" : "muted"}
            icon={<Download className="h-4 w-4" />}
            label="เพลงในเครื่อง (เล่นได้แม้เน็ตหลุด)"
            value={
              r.audio.total > 0
                ? `${r.audio.ready}/${r.audio.total}`
                : localReady.length > 0
                  ? // no online master anywhere in this set, but the files are here
                    `${localReady.length} เพลงจากเครื่องนี้`
                  : "ไม่มีไฟล์เพลง"
            }
            action={
              needCount > 0 ? (
                busy ? (
                  <div className="ml-2 inline-flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {progress?.done ?? 0}/{progress?.total ?? needCount}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => abortRef.current?.abort()}
                    >
                      หยุด
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="ml-2" onClick={prepare}>
                    <Download className="h-3.5 w-3.5" /> เตรียม {needCount} เพลง
                  </Button>
                )
              ) : undefined
            }
          />

          {/* Rows whose song has no online master. Bytes held here = playable
              (⭐#1 step 7, an upload still queued from a venue with no wifi);
              anything else is a track that will be silent, and no "เตรียม" fixes
              it — the fix is to put a file on that song. */}
          {localReady.length > 0 && (
            <Row
              tone="ok"
              icon={<HardDrive className="h-4 w-4" />}
              label="ไฟล์ที่รออัปโหลด (เล่นได้จากเครื่องนี้)"
              value={`${localReady.length} เพลง`}
            />
          )}
          {noFileAtAll.length > 0 && (
            <Row
              tone="bad"
              icon={<XCircle className="h-4 w-4" />}
              label="เพลงที่ยังไม่มีไฟล์เลย (จะเงียบตอนโชว์)"
              value={noFileAtAll
                .slice(0, 3)
                .map((c) => c.name)
                .join(", ")
                .concat(noFileAtAll.length > 3 ? ` +${noFileAtAll.length - 3}` : "")}
            />
          )}

          <Row
            tone={
              r.storage.persisted === true
                ? "ok"
                : r.storage.persisted === false
                  ? "warn"
                  : "muted"
            }
            icon={<ShieldCheck className="h-4 w-4" />}
            label="พื้นที่ถูกล็อก (กันเบราว์เซอร์ลบไฟล์เพลง)"
            value={
              r.storage.persisted === true
                ? "ล็อกแล้ว"
                : r.storage.persisted === false
                  ? "ยังไม่ล็อก"
                  : "ไม่ทราบ"
            }
            action={
              notPinned ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={pin}
                  disabled={pinBusy}
                >
                  {pinBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  ล็อกพื้นที่
                </Button>
              ) : undefined
            }
          />

          {r.storage.free != null && (
            <Row
              tone={lowSpace ? "warn" : "ok"}
              icon={<HardDrive className="h-4 w-4" />}
              label="พื้นที่ว่างในเครื่อง"
              value={formatBytes(r.storage.free)}
            />
          )}

          {r.battery.supported && r.battery.level != null && (
            <Row
              tone={lowBattery ? "warn" : "ok"}
              icon={<BatteryMedium className="h-4 w-4" />}
              label="แบตเตอรี่"
              value={`${Math.round(r.battery.level * 100)}%${r.battery.charging ? " · กำลังชาร์จ" : ""}`}
            />
          )}

          {/* desktop-only: where the show audio is routed (set in Live Mode) */}
          {sink && (
            <Row
              tone={sink.missing ? "warn" : "ok"}
              icon={<Speaker className="h-4 w-4" />}
              label="เสียงออกที่"
              value={sink.label}
            />
          )}

          {/* desktop-only: can this event cold-boot offline (data cached)? */}
          {offlineData != null && (
            <Row
              tone={offlineData ? "ok" : "warn"}
              icon={<HardDrive className="h-4 w-4" />}
              label="ข้อมูลงานในเครื่อง (เปิดแบบไม่มีเน็ตได้)"
              value={offlineData ? "พร้อม" : "เปิดงานนี้ตอนออนไลน์ 1 ครั้งก่อน"}
            />
          )}

          <Row
            tone={r.online ? "ok" : "muted"}
            icon={r.online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            label="การเชื่อมต่อ"
            value={r.online ? "ออนไลน์" : "ออฟไลน์ — รันจากเครื่องนี้ได้"}
          />
        </div>
      )}
    </div>
  );
}
