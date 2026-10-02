// app/globals.css — the two global rules this file owns after round 15:
//  • .no-scrollbar: a sideways chip row that does not draw its scrollbar. The build
//    has no autoprefixer, so the ::-webkit-scrollbar twin has to be written by hand
//    (Safari before 18.2 ignores `scrollbar-width`).
//    This file is WEB ONLY — the .exe's desktop/src/index.css imports theme.css and
//    stage.css, never globals.css — so a component the .exe renders must keep
//    Tailwind's `[scrollbar-width:none]` beside `no-scrollbar` until the two rules
//    move to a shared sheet (the last describe follows the .exe's import chain).
//  • scroll-padding on <html>: keyboard focus must stop in the visible band between
//    the sticky header and the tab bar / sticky save bar, never fully under them.
// jsdom has no layout, so these pin the RULES (the tokens they use, the order of
// their pieces); where the focus actually lands is the tab-order harness's job.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import postcss from "postcss";

const file = path.resolve(__dirname, "globals.css");
const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });

/** Declarations of every rule with exactly this selector, optionally only inside the
 *  given at-rule (e.g. "media (min-width: 1024px)"), whitespace-squeezed. */
function decls(selector: string, inAtRule?: string): Record<string, string> {
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    const parent = rule.parent;
    const wrapped = parent && parent.type === "atrule" ? (parent as postcss.AtRule) : null;
    if (inAtRule === undefined ? wrapped !== null : wrapped === null || `${wrapped.name} ${wrapped.params}` !== inAtRule) {
      return;
    }
    rule.walkDecls((d) => {
      out[d.prop] = d.value.replace(/\s+/g, " ");
    });
  });
  return out;
}

describe("globals.css — .no-scrollbar", () => {
  it("hides the scrollbar in both engines: scrollbar-width AND the ::-webkit-scrollbar twin", () => {
    expect(decls(".no-scrollbar")["scrollbar-width"]).toBe("none");
    expect(decls(".no-scrollbar::-webkit-scrollbar")["display"]).toBe("none");
  });
});

describe("globals.css — scroll-padding on the root scroller", () => {
  const TOP_PHONE = "calc(var(--header-h) + var(--offline-strip-h, 0px) + env(safe-area-inset-top) + 8px)";

  it("keeps focus clear of the header (+ the offline strip it grows by, + the notch)", () => {
    expect(decls("html")["scroll-padding-top"]).toBe(TOP_PHONE);
  });

  it("keeps focus clear of the tab bar and the home indicator", () => {
    expect(decls("html")["scroll-padding-bottom"]).toBe(
      "calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 12px)"
    );
  });

  it("a page carrying `has-action-bar` reserves the sticky save bar on top of that", () => {
    const withBar = decls("html:has(.has-action-bar)")["scroll-padding-bottom"];
    expect(withBar).toBe("calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 12px + 76px)");
  });

  it("lg restates the tokens html cannot see: the 56px header row, no tab bar", () => {
    // The (app) layout sets `lg:[--header-h:56px] lg:[--tabbar-h:0px]` on its own
    // wrapper, BELOW <html>; html itself still reads the phone's 52px / 58px.
    const lg = "media (min-width: 1024px)";
    expect(decls("html", lg)["scroll-padding-top"]).toBe(
      "calc(56px + var(--offline-strip-h, 0px) + env(safe-area-inset-top) + 8px)"
    );
    expect(decls("html", lg)["scroll-padding-bottom"]).toBe("calc(env(safe-area-inset-bottom) + 12px)");
    expect(decls("html:has(.has-action-bar)", lg)["scroll-padding-bottom"]).toBe(
      "calc(env(safe-area-inset-bottom) + 12px + 76px)"
    );
  });

  it("the :has() rule stands alone — a selector list would be dropped whole where :has() cannot parse", () => {
    const hasRules: string[] = [];
    root.walkRules((r) => {
      if (r.selector.includes(":has(")) hasRules.push(r.selector.replace(/\s+/g, " ").trim());
    });
    expect(hasRules.length).toBeGreaterThan(0);
    for (const s of hasRules) expect(s).not.toContain(",");
  });
});

/** The CSS the .exe loads for `entry`: the file plus every RELATIVE @import, recursively
 *  (bare package imports — the @fontsource faces — are fonts, not followed). */
function cssChain(entry: string, seen: Set<string> = new Set()): string {
  const abs = path.resolve(entry);
  if (seen.has(abs)) return "";
  seen.add(abs);
  const src = fs.readFileSync(abs, "utf8");
  let out = src;
  postcss.parse(src, { from: abs }).walkAtRules("import", (r) => {
    const m = /^\s*(?:url\()?["']([^"']+)["']/.exec(r.params);
    if (m && m[1].startsWith(".")) out += "\n" + cssChain(path.resolve(path.dirname(abs), m[1]), seen);
  });
  return out;
}

/** Every string literal under components/ (not tests) that names the `no-scrollbar` class. */
function noScrollbarUsages(dir: string, out: { file: string; classes: string[] }[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) noScrollbarUsages(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/["'`]([^"'`\n]*(?<![\w-])no-scrollbar(?![\w-])[^"'`\n]*)["'`]/g)) {
        out.push({ file: path.relative(path.resolve(__dirname, ".."), p).replace(/\\/g, "/"), classes: m[1].split(/\s+/) });
      }
    }
  }
  return out;
}

describe("`no-scrollbar` in a component the .exe renders", () => {
  // desktop/src/index.css does NOT import globals.css — the practice room, the library
  // and every other reused component reach the .exe with only theme.css + stage.css.
  const desktopCss = cssChain(path.resolve(__dirname, "../desktop/src/index.css"));
  const usages = noScrollbarUsages(path.resolve(__dirname, "../components"));

  it("the walk finds what it should, so the check below cannot pass for nothing", () => {
    expect(desktopCss).toContain("--header-h"); // theme.css, through the chain
    expect(desktopCss).toContain("@keyframes onair"); // stage.css, through the chain
    const files = usages.map((u) => u.file);
    expect(files).toContain("components/practice/practice-player.tsx");
    expect(files).toContain("components/practice/practice-journal.tsx");
  });

  it("is either defined in the CSS the .exe loads, or sits beside [scrollbar-width:none]", () => {
    // Today the class lives in globals.css only; Electron's Chromium honours the
    // Tailwind class, so each use keeps it. Move `.no-scrollbar` into stage.css and
    // this passes without it.
    if (/\.no-scrollbar\b/.test(desktopCss)) return;
    for (const u of usages) {
      expect(u.classes, `${u.file}: the .exe would draw this row's scrollbar`).toContain("[scrollbar-width:none]");
    }
  });
});
