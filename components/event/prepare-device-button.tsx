"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  CheckCircle2,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  prefetchEventAudio,
  getReadiness,
  type PrefetchTarget,
  type Readiness,
} from "@/lib/audio-prefetch";

/**
 * Per-device "prepare this device" control on the event page: downloads all of
 * the event's audio into the on-device cache ahead of time so Live Mode plays
 * offline. Shows a ready ✓ when this device already holds the current versions,
 * and re-checks/updates if a library file was replaced.
 */
export function PrepareDeviceButton({
  eventId,
  targets,
}: {
  eventId: string;
  targets: PrefetchTarget[];
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [failed, setFailed] = useState(0);
  const cancelRef = useRef(false);

  const refresh = useCallback(() => {
    getReadiness(eventId, targets)
      .then(setReadiness)
      .catch(() => {});
  }, [eventId, targets]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(async () => {
    setBusy(true);
    setFailed(0);
    cancelRef.current = false;
    const res = await prefetchEventAudio(eventId, targets, {
      onProgress: (p) => setProgress({ done: p.done, total: p.total }),
      isCancelled: () => cancelRef.current,
    });
    setFailed(res.failed);
    setProgress(null);
    setBusy(false);
    refresh();
  }, [eventId, targets, refresh]);

  // No audio on this event → nothing to prepare.
  if (targets.length === 0) return null;

  const allReady =
    !!readiness && readiness.total > 0 && readiness.ready === readiness.total;
  const needCount = readiness
    ? readiness.stale + readiness.missing
    : targets.length;

  if (busy) {
    return (
      <div className="inline-flex items-center gap-2">
        <Button variant="outline" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          กำลังโหลด {progress?.done ?? 0}/{progress?.total ?? needCount}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            cancelRef.current = true;
          }}
        >
          หยุด
        </Button>
      </div>
    );
  }

  if (allReady && failed === 0) {
    return (
      <div className="inline-flex items-center gap-1">
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-green-600/30 bg-green-600/10 px-2.5 py-1.5 text-sm font-medium text-green-700 dark:text-green-400"
          title="ไฟล์เพลงทั้งหมดอยู่ในเครื่องนี้แล้ว เล่นได้แม้เน็ตหลุด"
        >
          <CheckCircle2 className="h-4 w-4" /> พร้อมออฟไลน์ · {readiness!.total} เพลง
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={run}
          title="ตรวจ/อัปเดตเวอร์ชันไฟล์ให้ตรงกับคลัง"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <Button variant="outline" onClick={run} title="โหลดไฟล์เพลงของงานนี้ลงเครื่องนี้ไว้ก่อน">
        <Download className="h-4 w-4" />
        เตรียมเครื่องนี้ · {needCount} เพลง
      </Button>
      {failed > 0 && (
        <span className="inline-flex items-center gap-1 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {failed} ไฟล์โหลดไม่ได้
        </span>
      )}
    </div>
  );
}
