/**
 * Dark / light, the app's one theme switch. The class on <html> IS the theme (dark
 * by default — venues are dark), the choice is remembered per device under
 * `cueiq:theme`, and the root layout's pre-paint script replays it before first
 * paint. That script cannot import this module, so it reads the same two names from
 * here as interpolated constants (app/layout.tsx).
 *
 * The browser chrome follows too: <meta name="theme-color"> tints the status bar of
 * an installed PWA and Android Chrome's toolbar. Left at one colour, a light-mode
 * page sat under a near-black bar (or the other way round). The values are the two
 * themes' page backgrounds from the design spec (FINAL-SPEC-v2 §F.4).
 */
export const THEME_STORAGE_KEY = "cueiq:theme";
export const THEME_COLOR = { dark: "#070708", light: "#f1f1f3" } as const;

export function isDarkMode(): boolean {
  return typeof document === "undefined" || document.documentElement.classList.contains("dark");
}

export function setThemeMode(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    // Storage refused (private window): the switch still applies for this visit,
    // it just will not be remembered — the same as before this module existed.
  }
}
