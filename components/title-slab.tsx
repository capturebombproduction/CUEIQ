import { cn } from "@/lib/utils";
import { THAI_RE } from "@/lib/thai";

// " — ", " – " or " - " with whitespace on both sides: the way show names are written
// ("Japan Expo 2026 — Red Revolution"). Whitespace is required so a hyphenated word
// ("Hi-Fi Night") or a date range ("12-14") is never cut in two.
const SEP = /\s+[—–-]\s+/;

/**
 * Split a show name into the part before the dash (the kicker: festival, venue, tour)
 * and the show's own title after it. No separator leaves the whole name as the title.
 * Trimmed first, so the whitespace SEP demands on both sides always has text beyond it.
 */
export function splitEventName(name: string): { kicker: string | null; title: string } {
  const whole = name.trim();
  const m = SEP.exec(whole);
  if (!m) return { kicker: null, title: whole };
  const kicker = whole.slice(0, m.index).trim();
  const title = whole.slice(m.index + m[0].length).trim();
  return { kicker, title };
}

type Tag = "div" | "h1" | "h2" | "h3";

/**
 * The show name as a poster (spec §E.11): the kicker upright above, the title on a
 * band parallelogram per line (`.title-slab`: --primary-foreground on --primary, the
 * pair lib/skin.ts holds at AA for every band). Rendered AS TYPED — never CSS
 * uppercase: these are names people chose.
 *
 * Not for exported / printed surfaces: those use `.poster`, flat and upright (§D).
 */
export function TitleSlab({
  name,
  size,
  kickerSize = 16,
  clamp = 2,
  as: Comp = "div",
  className,
}: {
  name: string;
  /** title font size in px (38 ticket · 27 event hero · 26 Overview · 22 tokens) */
  size: number;
  kickerSize?: number;
  /** lines before the title truncates, when there is a kicker */
  clamp?: 2 | 3;
  as?: Tag;
  className?: string;
}) {
  const { kicker, title } = splitEventName(name);
  // Spans, not divs, so the whole thing may sit inside a heading. The clamp classes
  // make each one a block box of its own.
  return (
    <Comp className={cn("min-w-0", className)}>
      {kicker && (
        <span className="poster clamp-2 text-foreground/90" style={{ fontSize: kickerSize }}>
          {kicker}
        </span>
      )}
      <span
        className={cn(
          "slab-line",
          // With no kicker the whole name is the slab, set smaller and allowed a line more.
          (kicker ? clamp : 3) === 2 ? "clamp-2" : "line-clamp-3",
          kicker && "mt-1",
          // Kanit's taller content box makes per-line slabs touch at 1.14.
          THAI_RE.test(title) && "thai"
        )}
      >
        <span
          className="title-slab"
          style={{ fontSize: kicker ? size : Math.round(size * 0.75) }}
        >
          {title}
        </span>
      </span>
    </Comp>
  );
}
