"use client";

// The beat light in the NOW card's top strip: four squares, one lit per beat, the first of the
// bar in red - a count-in for whoever cues the stage. Phased from the song's own first beat
// (songs.beat_offset, 0045) and tempo (songs.bpm), against the PLAYER's position, so it is on
// the music's beat, not a free-running blink. Only where the file plays (the player is the
// clock). Like the Signal strip it animates by writing to its nodes - Live never re-renders.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { beatAt } from "@/lib/song-signal";

export { beatAt };

/** How long a beat stays lit, as a fraction of the beat. */
const LIT = 0.3;

export function BeatLight({
  bpm,
  offset,
  clock,
  className,
}: {
  bpm: number;
  offset: number;
  /** the player's position in seconds, or null when nothing is playing */
  clock: () => number | null;
  className?: string;
}) {
  const dots = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = clock();
      const at = t === null ? null : beatAt(t, bpm, offset);
      dots.current.forEach((d, i) => {
        if (!d) return;
        d.dataset.on = at && at.beat === i && at.phase < LIT ? "1" : at && at.beat === i ? "cur" : "0";
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [bpm, offset, clock]);
  return (
    <span
      data-testid="beat-light"
      title={`จังหวะของเพลง ${bpm} BPM — ดวงแดง = จังหวะที่ 1 ของห้อง`}
      className={cn("items-center gap-[5px] px-1.5", className)}
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          ref={(el) => {
            dots.current[i] = el;
          }}
          data-on="0"
          className={cn(
            "size-2 bg-foreground/15 data-[on=cur]:bg-foreground/35",
            i === 0
              ? "data-[on='1']:bg-[hsl(var(--notify))] data-[on='1']:shadow-[0_0_8px_hsl(var(--notify))]"
              : "data-[on='1']:bg-foreground data-[on='1']:shadow-[0_0_8px_hsl(var(--foreground)/.8)]"
          )}
        />
      ))}
      <span className="num text-[13px] leading-none text-muted-foreground">{bpm}</span>
    </span>
  );
}
