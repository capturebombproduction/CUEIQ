"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Trash2, Loader2 } from "lucide-react";
import {
  getCacheSummary,
  clearEventAudio,
  clearAllAudio,
  type CacheSummary,
} from "@/lib/audio-store";

function fmtSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Tiny housekeeping footer on the dashboard: how much audio this device holds,
 * with one-tap clears. A PA device reused across many shows accumulates cached
 * WAVs (and `storage.persist()` stops the browser evicting them), so let the user
 * reclaim space — clearing past shows is the safe default; the upcoming show's
 * files are untouched.
 */
export function DeviceStorage({
  pastEventIds,
  onChanged,
}: {
  pastEventIds: string[];
  onChanged?: () => void;
}) {
  const [summary, setSummary] = useState<CacheSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    getCacheSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);

  if (!summary || summary.fileCount === 0) return null;

  const pastSet = new Set(pastEventIds);
  const pastEntries = Object.entries(summary.byEvent).filter(([id]) =>
    pastSet.has(id)
  );
  const pastBytes = pastEntries.reduce((n, [, v]) => n + v.bytes, 0);

  const clearPast = async () => {
    setBusy(true);
    for (const [id] of pastEntries) {
      await clearEventAudio(id).catch(() => {});
    }
    setBusy(false);
    refresh();
    onChanged?.();
  };

  const clearAll = async () => {
    setBusy(true);
    await clearAllAudio().catch(() => {});
    setBusy(false);
    refresh();
    onChanged?.();
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <HardDrive className="h-3.5 w-3.5" />
        เพลงในเครื่องนี้{" "}
        <b className="text-foreground">{fmtSize(summary.totalBytes)}</b> ·{" "}
        {summary.fileCount} ไฟล์
      </span>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {pastEntries.length > 0 && (
        <button
          type="button"
          onClick={clearPast}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition hover:bg-muted hover:text-foreground disabled:opacity-60"
          title="ลบไฟล์เพลงของงานที่จัดไปแล้ว (งานที่กำลังจะถึงไม่ถูกลบ)"
        >
          <Trash2 className="h-3.5 w-3.5" /> ล้างงานที่ผ่านแล้ว ({fmtSize(pastBytes)})
        </button>
      )}
      <button
        type="button"
        onClick={clearAll}
        disabled={busy}
        className="ml-auto underline-offset-2 transition hover:text-foreground hover:underline disabled:opacity-60"
        title="ลบไฟล์เพลงที่แคชไว้ทั้งหมดบนเครื่องนี้ (รวมงานที่กำลังจะถึง)"
      >
        ล้างทั้งหมด
      </button>
    </div>
  );
}
