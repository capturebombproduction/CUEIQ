// Band "DNA color" / skin support. A skin recolors the app's --primary AND washes
// the neutral surfaces (background / card / border …) with the brand hue, in BOTH
// light and dark, by injecting a <style id="cueiq-skin"> with :root + .dark rules.
// Stored per-device for now (localStorage); the future paid feature persists a skin
// per band in the DB.

import { hexToHsl, skinCss } from "@/lib/skin";
export { hexToHsl, skinCss };

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

/** Inject / replace the live skin <style>. The skin's :root / .dark rules tie the app
 *  stylesheet's tokens on specificity, so it has to come LAST in <head> to win — an
 *  element that already exists is moved there too (a no-op when it is already last),
 *  not just reused where it happens to sit: the desktop's early copy used to sit
 *  before Vite's <link>, and a colour picked after a restart was written into it and
 *  still lost. */
function injectSkinCss(css: string) {
  let el = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = SKIN_STYLE_ID;
  }
  if (el.parentNode !== document.head || el !== document.head.lastElementChild) {
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

/**
 * Re-derive the saved skin from its hex. The stored CSS is a snapshot of what
 * skinCss() produced on the day the colour was picked, and the pre-paint script
 * replays that snapshot as-is — so after any change to the theme tokens or to
 * skinCss(), a device with a saved colour kept painting the OLD overrides until
 * somebody happened to pick a colour again. Returns true when it rewrote it.
 */
export function refreshSavedAccent(): boolean {
  try {
    const a = JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) || "null");
    if (!a?.hex) return false;
    if (a.css === skinCss(a.hex)) return false;
    saveAccent(a.hex);
    return true;
  } catch {
    return false;
  }
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
