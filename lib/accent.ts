// Band "DNA color" / skin support. A skin recolors the app's --primary AND washes
// the neutral surfaces (background / card / border …) with the brand hue, in BOTH
// light and dark, by injecting a <style id="cueiq-skin"> with :root + .dark rules.
// Stored per-device for now (localStorage); the future paid feature persists a skin
// per band in the DB.

export const ACCENT_STORAGE_KEY = "cueiq:accent";
export const SKIN_STYLE_ID = "cueiq-skin";

export interface AccentPreset {
  name: string;
  hex: string;
}

// Starter palette incl. the Seishin Kakumei brand colors (from their CI guide).
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "CueIQ (เริ่มต้น)", hex: "#4f46e5" }, // indigo — the app default
  { name: "Seishin Kakumei", hex: "#a62a1c" }, // band DNA red (#A62A1C)
  { name: "Seishin Gold", hex: "#8a7436" }, // band DNA olive-gold (#8A7436)
  { name: "Seishin Green", hex: "#15a65a" }, // band secondary green (#15A65A)
  { name: "Crimson", hex: "#e11d48" },
  { name: "Sunset", hex: "#f97316" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Sky", hex: "#0ea5e9" },
  { name: "Royal", hex: "#2563eb" },
  { name: "Sakura", hex: "#ec4899" },
];

export const DEFAULT_ACCENT_HEX = ACCENT_PRESETS[0].hex;

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
  // dark-mode primary reads a touch lighter than a very dark accent
  const darkL = Math.min(70, Math.max(46, l));
  const sat = Math.min(85, s); // keep CTAs vivid but not neon
  // low-saturation brand wash for the neutral surfaces
  const wash = Math.min(26, Math.round(s * 0.4));
  return `:root{--primary:${h} ${s}% ${l}%;--ring:${h} ${s}% ${l}%;--primary-foreground:${fg};--accent:${h} ${Math.round(
    s * 0.35
  )}% 95%;--accent-foreground:${h} ${s}% 30%;--background:${h} ${Math.min(
    18,
    wash
  )}% 99%;--card:0 0% 100%;--popover:0 0% 100%;--secondary:${h} ${wash}% 96%;--muted:${h} ${wash}% 96%;--border:${h} ${wash}% 90%;--input:${h} ${wash}% 90%;}.dark{--primary:${h} ${sat}% ${darkL}%;--ring:${h} ${sat}% ${darkL}%;--primary-foreground:${fg};--accent:${h} ${wash}% 22%;--accent-foreground:0 0% 98%;--background:${h} ${wash}% 7%;--card:${h} ${wash}% 11%;--popover:${h} ${wash}% 11%;--secondary:${h} ${wash}% 16%;--muted:${h} ${wash}% 16%;--border:${h} ${wash}% 21%;--input:${h} ${wash}% 23%;}`;
}

/** Inject / replace the live skin <style>. */
function injectSkinCss(css: string) {
  let el = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = SKIN_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** Apply + remember the skin (the pre-paint script re-injects it on next load). */
export function saveAccent(hex: string) {
  const css = skinCss(hex);
  injectSkinCss(css);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify({ hex, css }));
  } catch {}
}

/** Reset to default + forget the stored skin. */
export function resetAccent() {
  document.getElementById(SKIN_STYLE_ID)?.remove();
  try {
    localStorage.removeItem(ACCENT_STORAGE_KEY);
  } catch {}
}

/** The currently-saved accent hex, or null if using the default. */
export function loadAccentHex(): string | null {
  try {
    const a = JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) || "null");
    return a?.hex ?? null;
  } catch {
    return null;
  }
}
