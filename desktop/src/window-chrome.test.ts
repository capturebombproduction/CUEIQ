import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO THINGS THE WINDOW SHOWS BEFORE React has painted anything, and the one
// thing the desktop body forgot to copy from the web:
//
//  • BrowserWindow's backgroundColor — what the window is filled with until the first
//    paint. It was the old navy #0b1220 after the redesign made the page near-black
//    (hsl(243 30% 5%)), so every launch flashed the wrong colour. It is derived here
//    from theme.css's dark --background rather than pinned to a hex, so the next
//    change to that token fails THIS test instead of going stale in silence.
//  • body { -webkit-font-smoothing: antialiased } — the web gets it from the Tailwind
//    `antialiased` class on <body> (app/layout.tsx); the desktop's own body rule did
//    not, and light text on the dark stage rendered heavier in the .exe on macOS.
//
// Both are source reads: electron/main.cjs cannot be imported (it boots Electron) and
// jsdom does not apply a stylesheet's font smoothing. The packaged app's real colours
// are the browser harness's job.
// ─────────────────────────────────────────────────────────────────────────────

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(desktopDir, ...p), "utf8");

/** "243 30% 5%" -> "#090911" (round to the nearest channel, as a browser does). */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (
    "#" +
    [f(0), f(8), f(4)]
      .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

describe("the BrowserWindow's backgroundColor", () => {
  const theme = read("..", "app", "theme.css");
  const dark = /\.dark\s*\{[^}]*?--background:\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/.exec(
    theme
  );

  it("reads the dark theme's page colour out of theme.css", () => {
    expect(dark).not.toBeNull();
  });

  it("is that colour — not the pre-redesign navy", () => {
    const main = read("electron", "main.cjs");
    const win = /new BrowserWindow\(\{[\s\S]*?backgroundColor:\s*"(#[0-9a-fA-F]{6})"/.exec(main);
    expect(win).not.toBeNull();
    const want = hslToHex(Number(dark![1]), Number(dark![2]), Number(dark![3]));
    expect(win![1].toLowerCase()).toBe(want);
    expect(win![1].toLowerCase()).not.toBe("#0b1220");
  });
});

describe("the desktop body rule", () => {
  const css = read("src", "index.css");
  const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("smooths fonts the way the web's antialiased body does, in both engines' spellings", () => {
    expect(body).toMatch(/-webkit-font-smoothing:\s*antialiased/);
    expect(body).toMatch(/-moz-osx-font-smoothing:\s*grayscale/);
  });

  it("still paints the theme's background and text colour", () => {
    expect(body).toMatch(/background-color:\s*hsl\(var\(--background\)\)/);
    expect(body).toMatch(/color:\s*hsl\(var\(--foreground\)\)/);
  });
});
