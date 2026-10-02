import { cn } from "@/lib/utils";

export interface MicTileProps {
  /** the mic number / label as the crew calls it ("1", "H2") */
  mic: string | number;
  /** who holds it in this item */
  name?: string | null;
  /** the member's colour (members.color): a 4 px cap, so the same person reads the
   *  same at a glance from one item to the next */
  color?: string | null;
  /** a mic no one uses in this item: dimmed to 35 %, still in its place */
  off?: boolean;
  className?: string;
}

/** One mic (spec §E.11): number over name on a well, member-colour cap on top. */
export function MicTile({ mic, name, color, off, className }: MicTileProps) {
  return (
    <div className={cn("mic", off && "off", className)} data-off={off ? "" : undefined}>
      {/* The inset hairline keeps a pale (#efefef) or near-black (#434343) member colour
          from vanishing into the tile and the card around it. */}
      {color ? (
        <i aria-hidden style={{ background: color, boxShadow: "inset 0 0 0 1px hsl(var(--border))" }} />
      ) : null}
      <div className="num text-[21px] leading-[1.1]">{mic}</div>
      {name ? (
        <div className="truncate px-0.5 text-[11px] leading-tight text-muted-foreground">{name}</div>
      ) : null}
      {/* The dimming is visual only; say it for screen readers too. */}
      {off ? <span className="sr-only">ไม่ได้ใช้</span> : null}
    </div>
  );
}

/**
 * The mic line-up for one item: 6 across on a phone, 3 × 2 in the stage layout (the
 * NEXT column is narrow there). Tiles keep a fixed order, so a mic is always in the
 * same place and "who is on 3" is answered by position.
 */
export function MicGrid({ mics, className }: { mics: MicTileProps[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-6 gap-[3px] stage:grid-cols-3", className)}>
      {mics.map((m, i) => (
        <MicTile key={`${m.mic}-${i}`} {...m} />
      ))}
    </div>
  );
}
