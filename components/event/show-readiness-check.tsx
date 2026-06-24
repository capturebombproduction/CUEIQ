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
  Wifi,
  WifiOff,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { prefetchEventAudio, type PrefetchTarget } from "@/lib/audio-prefetch";
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
}: {
  eventId: string;
  targets: PrefetchTarget[];
}) {
  const [r, setR] = useState<ShowReadiness | null>(null);
  const [open, setOpen] = useState(false);
  const userToggled = useRef(false); // once the user opens/closes, stop auto-driving it
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const cancelRef = useRef(false);

  const refresh = useCallback(() => {
    getShowReadiness(eventId, targets)
      .then((next) => {
        setR(next);
        // Auto-open the first time we learn audio isn't fully ready — but never
        // override a choice the user already made.
        if (!userToggled.current) {
          const needCount = next.audio.stale + next.audio.missing;
          setOpen(needCount > 0);
        }
      })
      .catch(() => {});
  }, [eventId, targets]);

  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, [refresh]);

  const prepare = useCallback(async () => {
    setBusy(true);
    cancelRef.current = false;
    await prefetchEventAudio(eventId, targets, {
      onProgress: (p) => setProgress({ done: p.done, total: p.total }),
      isCancelled: () => cancelRef.current,
    });
    setProgress(null);
    setBusy(false);
    refresh();
  }, [eventId, targets, refresh]);

  const pin = useCallback(async () => {
    setPinBusy(true);
    await requestPersist();
    setPinBusy(false);
    refresh();
  }, [refresh]);

  // No audio in this event → nothing to preflight (e.g. an MC-only run).
  if (targets.length === 0) return null;
  if (!r) return null;

  const needCount = r.audio.stale + r.audio.missing;
  const audioReady = r.audio.total > 0 && needCount === 0;

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
  const hasWarn = lowSpace || notPinned || lowBattery;

  const verdict: RowTone = !audioReady ? "bad" : hasWarn ? "warn" : "ok";
  const verdictText = !audioReady
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
              r.audio.total === 0
                ? "ไม่มีไฟล์เพลง"
                : `${r.audio.ready}/${r.audio.total}`
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
                      onClick={() => (cancelRef.current = true)}
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
