import { hexToHsl, spotFor } from "@/lib/skin";

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A band's (or member's) colour as the bare HSL triplet the stage classes read —
 * `.date-tile` through `--band`, `.lit` through `--lit`: "6 71% 38%". A missing or
 * garbled colour (an offline cached row can lack it) falls back to muted ink, so a
 * tile or key-line still paints instead of vanishing.
 */
export function bandTriplet(hex: string | null | undefined): string {
  const v = hex?.trim();
  if (!v || !HEX.test(v)) return "var(--muted-foreground)";
  const { h, s, l } = hexToHsl(v);
  return `${h} ${s}% ${l}%`;
}

/**
 * The inline variables for a `.lit` hero lit in ANOTHER band's colour (Artists' own
 * band, the Live Caller's act on stage — spec v3 §E.11 / §G.9 / §G.11): --lit keys
 * the edge in the band's colour, and --lit-g
 * makes the glow that band's capped stage light (lib/skin.ts spotFor). Without
 * --lit-g the glow would take --lit, the raw band colour, and a luminous band (SK
 * Green, Emerald) would glow past the light ceiling.
 *
 * A missing or garbled colour (groups.color is nullable; an offline cached row can
 * lack it) sets NOTHING, so the hero is lit like any other: the device's band edge
 * and its capped stage light. It used to key a muted edge and let the glow follow it
 * — and inside `.lit` the muted ink is the lifted L80 grey, luminance ≈ .59, three
 * times the light ceiling: a bright grey field with its own secondary text at 3.3:1.
 */
export function bandLitVars(hex: string | null | undefined): { "--lit"?: string; "--lit-g"?: string } {
  const v = hex?.trim();
  if (!v || !HEX.test(v)) return {};
  return { "--lit": bandTriplet(v), "--lit-g": spotFor(v).dark };
}
