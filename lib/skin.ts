// Pure skin helpers (no DOM) — safe to import in Server Components.
// A skin recolors --primary AND washes the neutral surfaces with the brand hue,
// in both light and dark, via :root + .dark CSS variable overrides.
//
// Every value a band colour puts under or around TEXT is walked, not guessed: a
// lightness is stepped until the WCAG ratio holds against the surface the colour
// really sits on (FINAL-SPEC-v2 §C). The old guesses failed real presets — "white
// text below L62" put white on Sunset's orange at 2.8:1, and the band red sat right
// next to the theme's own red on every delete button. The neutral WASH (the band
// hue tinting background / card / muted / border) is still the pre-redesign formula
// on purpose: round 3 re-lights the surfaces, and the walks below measure against
// whatever these surfaces are, so they follow it.
//
// No --warning / --alarm / --notify here, ever: the Live warning ladder, the
// overtime plate and the unread dot look the same for every band.

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

const WHITE = "0 0% 100%";
/** Text on a band fill too light for white: near-black (the redesign's light foreground). */
const INK = "240 30% 5%";

/** A token triplet ("6 71% 38%") → sRGB channels 0..1. */
function tripletToRgb(t: string): [number, number, number] {
  const [h, s, l] = t.trim().split(/\s+/).map((p) => parseFloat(p));
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two token triplets ("h s% l%"), 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(tripletToRgb(a));
  const lb = luminance(tripletToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text colour for a band FILL (buttons, the title slab, solid chips): white if AA is
 *  reachable by darkening the fill ≤ 5 points (never below `floorL`), else ink —
 *  lightening the fill if ink needs it. Keeps the band recognisably itself. */
function onFill(h: number, s: number, l: number, floorL: number): { L: number; fg: string } {
  for (let L = l; L >= Math.max(floorL, l - 5); L--) {
    if (contrast(WHITE, `${h} ${s}% ${L}%`) >= 4.5) return { L, fg: WHITE };
  }
  for (let L = l; L <= 85; L++) {
    if (contrast(INK, `${h} ${s}% ${L}%`) >= 4.5) return { L, fg: INK };
  }
  return { L: l, fg: INK };
}

/** Band colour as TEXT (--primary-ink): walk away from the surface to ≥ 4.6:1 — a
 *  hair over AA so rounding the lightness to a whole percent cannot dip under it. */
function inkL(h: number, s: number, start: number, surface: string, dir: 1 | -1): number {
  for (let L = start; L >= 5 && L <= 95; L += dir) {
    if (contrast(`${h} ${s}% ${L}%`, surface) >= 4.6) return L;
  }
  return start;
}

/** A field BOUNDARY (--input): walk until ≥ 3.1:1 against EVERY surface a field sits
 *  on (WCAG 1.4.11 non-text contrast) — a sunlit iPad has to find the box. */
function edgeL(h: number, s: number, start: number, surfaces: string[], dir: 1 | -1): number {
  for (let L = start; L >= 5 && L <= 95; L += dir) {
    if (surfaces.every((x) => contrast(`${h} ${s}% ${L}%`, x) >= 3.1)) return L;
  }
  return start;
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** The theme's own --destructive hues, light and dark (app/theme.css; a test keeps
 *  these in step). Measured against BOTH, because the guard below has to hold in
 *  whichever theme the device is in. */
export const THEME_DESTRUCTIVE_HUES = [354, 356] as const;
const DESTRUCTIVE_ALT_HUES = [265, 305];
/** Within this many degrees, "delete" and "our band" read as the same red. */
const MIN_DESTRUCTIVE_DIST = 45;

/** null = keep the theme's red. Otherwise the hue that moves --destructive clear of a
 *  red / orange / pink band (Seishin #a62a1c → 265, violet). A grey band has no hue
 *  to collide with. */
function destructiveHue(h: number, s: number): number | null {
  if (s < 15) return null;
  if (THEME_DESTRUCTIVE_HUES.every((d) => hueDist(d, h) >= MIN_DESTRUCTIVE_DIST)) return null;
  return (
    DESTRUCTIVE_ALT_HUES.find((c) => hueDist(c, h) >= MIN_DESTRUCTIVE_DIST) ??
    DESTRUCTIVE_ALT_HUES.reduce((a, b) => (hueDist(b, h) > hueDist(a, h) ? b : a))
  );
}

/** Build the skin CSS (light + dark variable overrides) for an accent hex. A pure
 *  string: saveAccent stores it, the pre-paint script replays it, and
 *  refreshSavedAccent rewrites any stored copy that no longer equals it. */
export function skinCss(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  const sat = Math.min(85, s);
  const wash = Math.min(26, Math.round(s * 0.4));

  // The surfaces (pre-redesign wash). The walks below measure against these.
  const page = `${h} ${Math.min(18, wash)}% 99%`;
  const darkPage = `${h} ${wash}% 7%`;
  const darkCard = `${h} ${wash}% 11%`; // = --popover; fields and slabs sit on it

  const lt = onFill(h, s, l, 20);
  const dk = onFill(h, sat, Math.min(70, Math.max(46, l)), 44);
  const inkLight = inkL(h, s, Math.min(lt.L, 50), WHITE, -1);
  const inkDark = inkL(h, Math.min(90, sat), Math.max(dk.L, 60), darkCard, 1);
  const inLight = edgeL(h, wash, 54, [WHITE, page], -1);
  const inDark = edgeL(h, wash, 40, [darkCard, darkPage], 1);
  const dh = destructiveHue(h, s);
  const dz = dh === null ? "" : `--destructive:${dh} 68% 44%;`;

  return (
    `:root{--primary:${h} ${s}% ${lt.L}%;--ring:${h} ${s}% ${lt.L}%;--primary-foreground:${lt.fg};` +
    `--primary-ink:${h} ${s}% ${inkLight}%;--accent:${h} ${Math.round(s * 0.35)}% 95%;` +
    `--accent-foreground:${h} ${s}% 30%;--background:${page};--card:0 0% 100%;--popover:0 0% 100%;` +
    `--secondary:${h} ${wash}% 96%;--muted:${h} ${wash}% 96%;--border:${h} ${wash}% 90%;` +
    `--input:${h} ${wash}% ${inLight}%;${dz}}` +
    `.dark{--primary:${h} ${sat}% ${dk.L}%;--ring:${h} ${sat}% ${dk.L}%;--primary-foreground:${dk.fg};` +
    `--primary-ink:${h} ${Math.min(90, sat)}% ${inkDark}%;--accent:${h} ${wash}% 22%;` +
    `--accent-foreground:0 0% 98%;--background:${darkPage};--card:${darkCard};--popover:${darkCard};` +
    `--secondary:${h} ${wash}% 16%;--muted:${h} ${wash}% 16%;--border:${h} ${wash}% 21%;` +
    `--input:${h} ${wash}% ${inDark}%;${dz}}`
  );
}
