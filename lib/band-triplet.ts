import { hexToHsl } from "@/lib/skin";

/**
 * A band's (or member's) colour as the bare HSL triplet the stage classes read —
 * `.date-tile` through `--band`, `.lit` through `--lit`: "6 71% 38%". A missing or
 * garbled colour (an offline cached row can lack it) falls back to muted ink, so a
 * tile or key-line still paints instead of vanishing.
 */
export function bandTriplet(hex: string | null | undefined): string {
  const v = hex?.trim();
  if (!v || !/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return "var(--muted-foreground)";
  const { h, s, l } = hexToHsl(v);
  return `${h} ${s}% ${l}%`;
}
