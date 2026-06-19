// Band "DNA color" / skin support. We override the app's --primary (+ ring +
// foreground) CSS variables with the chosen color so every primary CTA, badge and
// focus ring takes on the band's identity. Stored per-device for now (localStorage);
// the future paid feature would persist a skin per band in the DB.

export const ACCENT_STORAGE_KEY = "cueiq:accent";

export interface AccentPreset {
  name: string;
  hex: string;
}

// A starter palette of common idol/artist "DNA" colors. Pick a custom one for an
// exact brand match.
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "CueIQ (เริ่มต้น)", hex: "#4f46e5" }, // indigo — the app default
  { name: "Crimson", hex: "#e11d48" },
  { name: "Sunset", hex: "#f97316" },
  { name: "Gold", hex: "#d4af37" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Teal", hex: "#0d9488" },
  { name: "Sky", hex: "#0ea5e9" },
  { name: "Royal", hex: "#2563eb" },
  { name: "Violet", hex: "#7c3aed" },
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

export interface AccentVars {
  primary: string; // "H S% L%"
  fg: string; // primary-foreground "H S% L%"
}

/** Compute the CSS-variable triplets for a hex accent. */
export function accentVars(hex: string): AccentVars {
  const { h, s, l } = hexToHsl(hex);
  return {
    primary: `${h} ${s}% ${l}%`,
    // white text on darker colors, near-black on light/bright ones
    fg: l < 62 ? "0 0% 100%" : "222 47% 11%",
  };
}

/** Apply the accent to the live document (both light + dark, via inline override). */
export function applyAccent(hex: string) {
  const v = accentVars(hex);
  const s = document.documentElement.style;
  s.setProperty("--primary", v.primary);
  s.setProperty("--ring", v.primary);
  s.setProperty("--primary-foreground", v.fg);
}

/** Clear the override → back to the app's built-in indigo. */
export function clearAccent() {
  const s = document.documentElement.style;
  s.removeProperty("--primary");
  s.removeProperty("--ring");
  s.removeProperty("--primary-foreground");
}

/** Apply + remember the accent (the pre-paint script reads this on next load). */
export function saveAccent(hex: string) {
  applyAccent(hex);
  try {
    localStorage.setItem(
      ACCENT_STORAGE_KEY,
      JSON.stringify({ hex, ...accentVars(hex) })
    );
  } catch {}
}

/** Reset to default + forget the stored accent. */
export function resetAccent() {
  clearAccent();
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
