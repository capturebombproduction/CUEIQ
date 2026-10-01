// The one theme switch. The browser's own chrome follows the page: an installed
// app's status bar (and Android Chrome's toolbar) is <meta name="theme-color">,
// and left at one colour a light page sat under a near-black bar.
import { describe, it, expect, afterEach, vi } from "vitest";
import { THEME_COLOR, THEME_STORAGE_KEY, isDarkMode, setThemeMode } from "./theme-mode";

afterEach(() => {
  document.documentElement.classList.add("dark");
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  vi.restoreAllMocks();
});

function meta() {
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = THEME_COLOR.dark;
  document.head.appendChild(m);
  return m;
}

describe("setThemeMode", () => {
  it("light: drops .dark, remembers it, and lightens the status bar", () => {
    const m = meta();
    setThemeMode(false);
    expect(isDarkMode()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(m.content).toBe(THEME_COLOR.light);
  });

  it("dark: back again", () => {
    const m = meta();
    setThemeMode(false);
    setThemeMode(true);
    expect(isDarkMode()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(m.content).toBe(THEME_COLOR.dark);
  });

  it("still switches when storage refuses (private window) — it just is not remembered", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => setThemeMode(false)).not.toThrow();
    expect(isDarkMode()).toBe(false);
  });

  it("the two colours are the two themes' page backgrounds the spec names", () => {
    expect(THEME_COLOR).toEqual({ dark: "#070708", light: "#f1f1f3" });
  });
});
