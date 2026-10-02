"use client";

import { AudioLines, Loader2, Pause, Play, X } from "lucide-react";
import { useHoldBottomSlot } from "@/lib/bottom-slot";
import { THAI_RE } from "@/lib/thai";
import { cn } from "@/lib/utils";

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
 * Fixed to the bottom, 8px ABOVE the tab bar: `--tabbar-h` is the space the bar
 * takes (0 from lg up, where there is none — see components/tab-bar.tsx) and the
 * safe-area inset keeps it off an iPhone's home indicator. Spotify-style: band
 * cover, title, time, then the two 44px controls under the right thumb.
 *
 * That slot is shared with the push nudge, which used to cover this player whole
 * (its z-50 outside <main> beats this z-40 inside it). The player holds the slot
 * while mounted and the nudge waits — lib/bottom-slot.ts.
 */
export function LibraryMiniPlayer({
  title,
  cover = null,
  position,
  duration,
  playing,
  loading,
  onToggle,
  onClose,
}: {
  title: string;
  /** the song's cover thumbnail (songs.cover, a data URL); null = the band tile */
  cover?: string | null;
  position: number;
  duration: number;
  playing: boolean;
  loading: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  useHoldBottomSlot();
  const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
  return (
    <div
      role="region"
      aria-label="ตัวอย่างเพลง"
      className="mini no-print fixed inset-x-2 z-40 mx-auto max-w-xl text-popover-foreground"
      style={{ bottom: "calc(var(--tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 8px)" }}
    >
      {/* Progress on the TOP edge, where the eye already is when reading the title. */}
      <div
        role="progressbar"
        aria-label="ความคืบหน้า"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(Math.min(position, duration || position))}
        className="h-[3px] w-full bg-foreground/15"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-linear motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex h-[60px] items-center gap-3 pl-2 pr-1">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element -- data-URL thumbnail
          <img src={cover} alt="" aria-hidden className="h-11 w-11 flex-none rounded-[2px] object-cover" />
        ) : (
          <span
            aria-hidden
            className="grid h-11 w-11 flex-none place-items-center rounded-[2px] bg-primary text-primary-foreground"
          >
            <AudioLines className="h-5 w-5" strokeWidth={2.4} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* Barlow has no Thai: a Thai title is set in Kanit, never at 800 */}
          <div
            className={cn(
              "truncate leading-tight",
              THAI_RE.test(title) ? "text-[16px] font-semibold" : "disp text-[18px]"
            )}
          >
            {title}
          </div>
          <div className="truncate text-[12.5px] text-muted-foreground">
            <span className="num text-[13.5px] text-foreground">{clock(position)}</span>
            <span className="num text-[13.5px]"> / {duration > 0 ? clock(duration) : "–:––"}</span>
            {" · ตัวอย่างในคลังเพลง"}
            {/* a master can be 88 MB over venue Wi-Fi — say why nothing is heard yet */}
            {loading && " · กำลังโหลด…"}
          </div>
        </div>
        <button
          type="button"
          className="grid h-11 w-11 flex-none place-items-center rounded-[2px] bg-primary text-primary-foreground transition-transform duration-1 active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          aria-label={loading ? "ยกเลิก" : playing ? "หยุดชั่วคราว" : "เล่นต่อ"}
          onClick={onToggle}
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : playing ? (
            <Pause className="h-5 w-5" aria-hidden />
          ) : (
            <Play className="h-5 w-5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="grid h-11 w-11 flex-none place-items-center rounded-[3px] text-muted-foreground transition-colors duration-2 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="ปิดตัวเล่น"
          onClick={onClose}
        >
          <X className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </div>
  );
}
