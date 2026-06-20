"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, DownloadCloud } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getReadiness, prefetchEventAudio } from "@/lib/audio-prefetch";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";

const OPT_OUT_KEY = "cueiq:autoPrefetch"; // value "off" disables auto-download

type NetInfo = { saveData?: boolean; effectiveType?: string };

/** Don't auto-pull big WAVs on a metered/slow link. We can't reliably detect
 * "is Wi-Fi" cross-browser, so respect the standard signals: offline, Data
 * Saver, or a 2g link all skip auto (the manual button still works). */
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
 * Silently pre-caches the soonest upcoming show's audio when the dashboard
 * loads, so the device is show-ready without anyone opening Live Mode first.
 * Idempotent (skips when already cached/fresh), gated to non-metered links, and
 * opt-out per device. Renders a small status line only while it's actually
 * doing/finished work.
 */
export function AutoPrefetch({
  eventId,
  groupId,
}: {
  eventId: string;
  groupId: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!autoAllowed()) return;

    (async () => {
      try {
        const supabase = createClient();
        const [itemsRes, songsRes] = await Promise.all([
          supabase
            .from("setlist_items")
            .select("id, song_id, audio_path, audio_name")
            .eq("event_id", eventId)
            .order("sort_order", { ascending: true }),
          supabase
            .from("songs")
            .select("id, audio_path, audio_name")
            .eq("group_id", groupId),
        ]);
        if (cancelledRef.current) return;
        // A partial fetch (e.g. songs failed on flaky Wi-Fi) would yield an
        // incomplete target list → prefetch's orphan-cleanup could delete good
        // cached audio. Only act on a fully successful read.
        if (itemsRes.error || songsRes.error) return;
        const items = itemsRes.data ?? [];
        if (items.length === 0) return;

        const songAudio: SongAudioMap = Object.fromEntries(
          (songsRes.data ?? []).map((s) => [
            s.id,
            { path: s.audio_path ?? null, name: s.audio_name ?? null },
          ])
        );
        const targets = resolveAudioTargets(items, songAudio);
        if (targets.length === 0) return;

        const r = await getReadiness(eventId, targets);
        if (cancelledRef.current) return;
        const todo = r.stale + r.missing;
        if (todo === 0) return; // already fully prepared — stay silent

        setStatus({ kind: "loading", done: 0, total: todo });
        await prefetchEventAudio(eventId, targets, {
          onProgress: (p) =>
            !cancelledRef.current &&
            setStatus({ kind: "loading", done: p.done, total: p.total }),
          isCancelled: () => cancelledRef.current,
        });
        if (!cancelledRef.current) setStatus({ kind: "done" });
      } catch {
        /* best-effort; the manual button on the event page is the fallback */
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [eventId, groupId]);

  if (status.kind === "idle") return null;

  return (
    <div className="flex w-full basis-full items-center gap-2 text-xs text-muted-foreground">
      {status.kind === "loading" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          กำลังเตรียมเพลงงานถัดไปลงเครื่องนี้ · {status.done}/{status.total}
        </>
      ) : (
        <>
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          งานถัดไปพร้อมเล่นออฟไลน์แล้ว
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
        title="ปิดการโหลดอัตโนมัติบนเครื่องนี้ (ยังกดเตรียมเองได้ในหน้างาน)"
      >
        <DownloadCloud className="h-3.5 w-3.5" /> ปิดออโต้
      </button>
    </div>
  );
}
