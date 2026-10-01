"use client";

import { Loader2, Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** m:ss, rounded DOWN — an elapsed clock must not read 0:01 half a second in. */
function clock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * The Library's preview player: what is playing, how far in, play/pause, close.
 * Driven entirely by useLibraryPreview — it holds no audio of its own.
 *
 * Fixed to the bottom, ABOVE a bottom tab bar when one exists: `--tabbar-h` is
 * the bar's height (0 while there is none) and the safe-area inset keeps it off
 * an iPhone's home indicator. z-50 sits it over the floating แจ้งปัญหา button
 * (z-40) rather than under it while a preview is open.
 */
export function LibraryMiniPlayer({
  title,
  position,
  duration,
  playing,
  loading,
  onToggle,
  onClose,
}: {
  title: string;
  position: number;
  duration: number;
  playing: boolean;
  loading: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
  return (
    <div
      role="region"
      aria-label="ตัวอย่างเพลง"
      className="no-print fixed inset-x-0 z-50 mx-auto w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
      style={{ bottom: "calc(var(--tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 8px)" }}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <Button
          type="button"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full"
          aria-label={loading ? "ยกเลิก" : playing ? "หยุดชั่วคราว" : "เล่นต่อ"}
          onClick={onToggle}
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : playing ? (
            <Pause />
          ) : (
            <Play />
          )}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {clock(position)} / {duration > 0 ? clock(duration) : "–:––"}
            {/* a master can be 88 MB over venue Wi-Fi — say why nothing is heard yet */}
            {loading && " · กำลังโหลด…"}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          aria-label="ปิดตัวเล่น"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="ความคืบหน้า"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(Math.min(position, duration || position))}
        className="h-1 w-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-linear motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
