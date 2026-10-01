import { cn } from "@/lib/utils";
import type { SetlistKind } from "@/lib/types";

// The run-time "DNA" strip (spec §E.11): one segment per setlist block, as wide as
// the block is long, with a 2 px gap between. Songs are the solid band, SE / INST /
// INT the band at .42, MC / GUEST a neutral — the shape of the set at a glance. What
// runs past the slot is one hatched segment (the band-independent alarm stripe), so
// "too long" never depends on reading a number.

export interface RunBlock {
  kind: SetlistKind;
  seconds: number;
}

export type RunSegmentKind = SetlistKind | "over" | "rest";

export interface RunSegment {
  kind: RunSegmentKind;
  seconds: number;
}

const SEG_CLASS: Record<RunSegmentKind, string> = {
  song: "bg-primary",
  se: "bg-primary/[.42]",
  instrument: "bg-primary/[.42]",
  interlude: "bg-primary/[.42]",
  mc: "bg-foreground/[.32]",
  guest: "bg-foreground/[.32]",
  over: "hatch",
  // the unused part of the slot: no fill, the track shows through
  rest: "",
};

const positive = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Pure layout: the segments left to right and the length the strip spans.
 *  • blocks inside the slot keep their kind; the part of any block past the slot is
 *    summed into ONE trailing "over" segment;
 *  • an under-filled slot ends in a "rest" segment, so widths stay proportional to
 *    the slot rather than stretching the set to fill it;
 *  • the span also reaches the hard-out, so its tick always lands on the strip.
 * Zero, negative and non-finite lengths are dropped (an empty row adds no gap).
 */
export function runSegments(
  blocks: RunBlock[],
  slotSeconds?: number | null,
  hardOutSeconds?: number | null
): { segments: RunSegment[]; total: number } {
  const slot = positive(slotSeconds) ? slotSeconds : null;
  const segments: RunSegment[] = [];
  let t = 0;
  let over = 0;
  for (const b of blocks) {
    if (!positive(b.seconds)) continue;
    const inside = slot == null ? b.seconds : Math.max(0, Math.min(b.seconds, slot - t));
    if (inside > 0) segments.push({ kind: b.kind, seconds: inside });
    over += b.seconds - inside;
    t += b.seconds;
  }
  if (over > 0) segments.push({ kind: "over", seconds: over });
  const total = Math.max(t, slot ?? 0, positive(hardOutSeconds) ? hardOutSeconds : 0);
  if (total > t) segments.push({ kind: "rest", seconds: total - t });
  return { segments, total };
}

const pct = (x: number, total: number) =>
  `${(Math.min(Math.max(x / total, 0), 1) * 100).toFixed(3)}%`;

export function RunMeter({
  blocks,
  slotSeconds,
  hardOutSeconds,
  playheadSeconds,
  label,
  className,
  trackClassName,
}: {
  blocks: RunBlock[];
  /** the length the show must fit (seconds); what runs past it is hatched */
  slotSeconds?: number | null;
  /** seconds from show start to the hard out: a 3 px tick, 5 px proud of the strip */
  hardOutSeconds?: number | null;
  /** elapsed seconds: the 4 × 16 playhead */
  playheadSeconds?: number | null;
  /** Thai summary for assistive tech; without one the strip is decorative */
  label?: string;
  className?: string;
  /** height / colour overrides for the strip itself (default 10 px; the Live dock uses h-2) */
  trackClassName?: string;
}) {
  const { segments, total } = runSegments(blocks, slotSeconds, hardOutSeconds);
  return (
    <div
      className={cn("relative", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <div className={cn("dna", trackClassName)}>
        {segments.map((s, i) => (
          <span
            key={i}
            data-kind={s.kind}
            className={SEG_CLASS[s.kind] ?? SEG_CLASS.se}
            style={{ flex: `${s.seconds} 1 0%` }}
          />
        ))}
      </div>
      {/* The marks sit OUTSIDE .dna: it clips (overflow hidden) and they stand proud. */}
      {total > 0 && positive(hardOutSeconds) && (
        <span
          data-mark="hard-out"
          className="absolute -bottom-[5px] -top-[5px] w-[3px] -translate-x-1/2 bg-foreground"
          style={{ left: pct(hardOutSeconds, total) }}
        />
      )}
      {total > 0 && typeof playheadSeconds === "number" && Number.isFinite(playheadSeconds) && (
        <span
          data-mark="playhead"
          className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 bg-foreground shadow-[0_0_0_2px_hsl(var(--background))]"
          style={{ left: pct(playheadSeconds, total) }}
        />
      )}
    </div>
  );
}
