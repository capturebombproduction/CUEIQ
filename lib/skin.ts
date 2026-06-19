// Pure skin helpers (no DOM) — safe to import in Server Components.
// A skin recolors --primary AND washes the neutral surfaces with the brand hue,
// in both light and dark, via :root + .dark CSS variable overrides.

/** "#4f46e5" → { h, s, l } in degrees / percent (rounded). */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let c = hex.replace("#", "").trim();
  if (c.length === 3) {
    c = c
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Build the skin CSS (light + dark variable overrides) for an accent hex. */
export function skinCss(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  const fg = l < 62 ? "0 0% 100%" : "222 47% 11%";
  const darkL = Math.min(70, Math.max(46, l));
  const sat = Math.min(85, s);
  const wash = Math.min(26, Math.round(s * 0.4));
  return `:root{--primary:${h} ${s}% ${l}%;--ring:${h} ${s}% ${l}%;--primary-foreground:${fg};--accent:${h} ${Math.round(
    s * 0.35
  )}% 95%;--accent-foreground:${h} ${s}% 30%;--background:${h} ${Math.min(
    18,
    wash
  )}% 99%;--card:0 0% 100%;--popover:0 0% 100%;--secondary:${h} ${wash}% 96%;--muted:${h} ${wash}% 96%;--border:${h} ${wash}% 90%;--input:${h} ${wash}% 90%;}.dark{--primary:${h} ${sat}% ${darkL}%;--ring:${h} ${sat}% ${darkL}%;--primary-foreground:${fg};--accent:${h} ${wash}% 22%;--accent-foreground:0 0% 98%;--background:${h} ${wash}% 7%;--card:${h} ${wash}% 11%;--popover:${h} ${wash}% 11%;--secondary:${h} ${wash}% 16%;--muted:${h} ${wash}% 16%;--border:${h} ${wash}% 21%;--input:${h} ${wash}% 23%;}`;
}
