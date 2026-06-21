"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Trash2, Loader2, ShieldAlert } from "lucide-react";
import {
  getCacheSummary,
  clearEventAudio,
  clearAllAudio,
  type CacheSummary,
} from "@/lib/audio-store";
import {
  getSongCacheSummary,
  clearSongCache,
  type SongCacheSummary,
} from "@/lib/song-cache";

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
 * files are untouched. Also warns when storage isn't "persisted" (could be
 * evicted) and offers a one-tap pin.
 */
export function DeviceStorage({
  pastEventIds,
  onChanged,
}: {
  pastEventIds: string[];
  onChanged?: () => void;
}) {
  const [summary, setSummary] = useState<CacheSummary | null>(null);
  const [songCache, setSongCache] = useState<SongCacheSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // null = unknown/unsupported; false = browser may evict the cache mid-show
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    getCacheSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
    getSongCacheSummary()
      .then(setSongCache)
      .catch(() => setSongCache(null));
  }, []);

  useEffect(() => {
    refresh();
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
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

  const requestPersist = async () => {
    try {
      const ok = await navigator.storage?.persist?.();
      setPersisted(ok ?? null);
    } catch {
      /* ignore */
    }
  };

  const eventBytes = summary?.totalBytes ?? 0;
  const eventCount = summary?.fileCount ?? 0;
  const songBytes = songCache?.totalBytes ?? 0;
  const songCount = songCache?.count ?? 0;
  if (eventCount === 0 && songCount === 0) return null;

  const pastSet = new Set(pastEventIds);
  const pastEntries = Object.entries(summary?.byEvent ?? {}).filter(([id]) =>
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

  const clearLibrary = async () => {
    setBusy(true);
    await clearSongCache().catch(() => {});
    setBusy(false);
    refresh();
    onChanged?.();
  };

  const clearAll = async () => {
    setBusy(true);
    await Promise.all([clearAllAudio().catch(() => {}), clearSongCache().catch(() => {})]);
    setBusy(false);
    refresh();
    onChanged?.();
  };

  return (
    <div className="space-y-2">
      {persisted === false && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span>
            พื้นที่เก็บเพลงยังไม่ถูกล็อก — เบราว์เซอร์อาจลบไฟล์ที่โหลดไว้ตอนพื้นที่ใกล้เต็ม
          </span>
          <button
            type="button"
            onClick={requestPersist}
            className="ml-auto rounded-md border border-amber-500/40 px-2 py-1 font-medium transition hover:bg-amber-500/20"
            title="ขอให้เบราว์เซอร์ปักหมุดพื้นที่ ไม่ให้ลบไฟล์เพลงอัตโนมัติ"
          >
            ล็อกพื้นที่
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5" />
          เพลงในเครื่องนี้{" "}
          <b className="text-foreground">{fmtSize(eventBytes + songBytes)}</b> ·{" "}
          {eventCount + songCount} ไฟล์
          {songCount > 0 && (
            <span className="text-muted-foreground/80">
              {" "}
              (คลังพรีโหลด {fmtSize(songBytes)})
            </span>
          )}
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {songCount > 0 && (
          <button
            type="button"
            onClick={clearLibrary}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition hover:bg-muted hover:text-foreground disabled:opacity-60"
            title="ลบคลังเพลงที่พรีโหลดไว้ (ซ้อม/ไลฟ์จะโหลดใหม่เมื่อเล่น)"
          >
            <Trash2 className="h-3.5 w-3.5" /> ล้างคลังพรีโหลด ({fmtSize(songBytes)})
          </button>
        )}
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
    </div>
  );
}
