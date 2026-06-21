"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, DownloadCloud } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  getLibraryReadiness,
  prefetchLibrary,
  type LibraryTarget,
} from "@/lib/library-prefetch";
import { pruneSupersededSongs } from "@/lib/song-cache";

const OPT_OUT_KEY = "cueiq:libraryPrefetch"; // value "off" disables library auto-download

type NetInfo = { saveData?: boolean; effectiveType?: string };

/** Same caution as the show prefetch: don't pull big WAVs on a metered/slow link. */
function autoAllowed(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return false;
  try {
    if (localStorage.getItem(OPT_OUT_KEY) === "off") return false;
  } catch {
    /* ignore */
  }
  const conn = (navigator as Navigator & { connection?: NetInfo }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /(?:^|-)2g$/.test(conn.effectiveType)) return false;
  return true;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; done: number; total: number }
  | { kind: "done" };

/**
 * On app open, silently pre-caches the band's WHOLE song library onto this device
 * so Practice Mode opens songs instantly and Live Mode has them ready too. Scoped
 * to the bands the user actually works with (the group ids passed in), idempotent
 * (skips already-cached files), gated to non-metered links, and opt-out per
 * device. Shows a small progress line only while doing/finishing work.
 */
export function LibraryPrefetch({ groupIds }: { groupIds: string[] }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const cancelledRef = useRef(false);
  const key = groupIds.slice().sort().join(",");

  useEffect(() => {
    cancelledRef.current = false;
    if (!key || !autoAllowed()) return;

    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("songs")
          .select("id, audio_path, audio_name")
          .in("group_id", key.split(","))
          .not("audio_path", "is", null);
        if (cancelledRef.current || error) return;
        const rows = (data ?? []).filter((s) => !!s.audio_path);
        const targets: LibraryTarget[] = rows.map((s) => ({
          path: s.audio_path as string,
          name: s.audio_name ?? null,
        }));
        // Free space from replaced files: drop superseded versions of songs we can
        // see (same songId, older path). Only acts on known songIds, so it never
        // touches a file from a band not represented here. Best-effort, non-blocking.
        const currentBySong = new Map(
          rows.map((s) => [String(s.id), s.audio_path as string])
        );
        pruneSupersededSongs(currentBySong).catch(() => {});
        if (targets.length === 0) return;

        const r = await getLibraryReadiness(targets);
        if (cancelledRef.current || r.missing === 0) return; // already fully cached

        setStatus({ kind: "loading", done: 0, total: r.missing });
        await prefetchLibrary(targets, {
          onProgress: (p) =>
            !cancelledRef.current &&
            setStatus({ kind: "loading", done: p.done, total: p.total }),
          isCancelled: () => cancelledRef.current,
        });
        if (!cancelledRef.current) setStatus({ kind: "done" });
      } catch {
        /* best-effort; songs still download on demand when played */
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [key]);

  if (status.kind === "idle") return null;

  return (
    <div className="flex w-full basis-full items-center gap-2 text-xs text-muted-foreground">
      {status.kind === "loading" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          กำลังเตรียมคลังเพลงของวงลงเครื่องนี้ · {status.done}/{status.total}
        </>
      ) : (
        <>
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          คลังเพลงพร้อมเล่นออฟไลน์แล้ว (ทั้งซ้อม + ไลฟ์)
        </>
      )}
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-1 underline-offset-2 hover:underline"
        onClick={() => {
          try {
            localStorage.setItem(OPT_OUT_KEY, "off");
          } catch {
            /* ignore */
          }
          cancelledRef.current = true;
          setStatus({ kind: "idle" });
        }}
        title="ปิดการพรีโหลดคลังเพลงบนเครื่องนี้"
      >
        <DownloadCloud className="h-3.5 w-3.5" /> ปิดออโต้
      </button>
    </div>
  );
}
