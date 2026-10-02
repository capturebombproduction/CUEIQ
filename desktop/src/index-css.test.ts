import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

// ─────────────────────────────────────────────────────────────────────────────
// THE ROOT SCROLLER'S keyboard-focus padding, in the CSS the .exe actually loads.
//
// The web keeps `html { scroll-padding-top/bottom }` (+ `html:has(.has-action-bar)`)
// in app/globals.css so Tab / scrollIntoView / a #hash jump stops in the visible band
// between the sticky header and the tab bar / sticky save bar, never fully under them
// (WCAG 2.4.11). desktop/src/index.css does NOT import globals.css — it loads theme.css
// + stage.css — so the rule never reached the desktop, which has the very same sticky
// 56px header and the very same event-workspace / event-form save bars. It restates the
// rule with its own numbers, and these tests pin where those numbers come from.
//
// Source reads on the .exe's import chain (the way app/globals.css.test.ts follows it
// for .no-scrollbar): jsdom has no layout, so where a focused field really lands is the
// browser harness's job, not this file's.
// ─────────────────────────────────────────────────────────────────────────────

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..");
const read = (...p: string[]) => readFileSync(join(desktopDir, ...p), "utf8");

interface Flat {
  selector: string;
  /** the at-rule the rule sits inside ("media (min-width: 1024px)"), or null at top level */
  atRule: string | null;
  decls: Record<string, string>;
}

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

function flat(rule: postcss.Rule, atRule: string | null): Flat {
  const decls: Record<string, string> = {};
  rule.each((n) => {
    if (n.type === "decl") decls[n.prop] = squeeze(n.value);
  });
  return { selector: squeeze(rule.selector), atRule, decls };
}

/** Every rule in the sheet the .exe loads for `entry`, in CASCADE order: a relative
 *  @import is replaced by the imported file's rules where the @import sits (bare package
 *  imports — the @fontsource faces — are fonts, not followed). */
function flatten(entry: string, seen: Set<string> = new Set()): Flat[] {
  const abs = resolve(entry);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const out: Flat[] = [];
  postcss.parse(readFileSync(abs, "utf8"), { from: abs }).each((node) => {
    if (node.type === "atrule" && node.name === "import") {
      const m = /^\s*(?:url\()?["']([^"']+)["']/.exec(node.params);
      if (m && m[1].startsWith(".")) out.push(...flatten(resolve(dirname(abs), m[1]), seen));
    } else if (node.type === "rule") {
      out.push(flat(node, null));
    } else if (node.type === "atrule") {
      node.walkRules((r) => {
        out.push(flat(r, `${node.name} ${squeeze(node.params)}`));
      });
    }
  });
  return out;
}

/** What the cascade leaves on `selector` at top level (no @media): later rules win. */
function cascaded(rules: Flat[], selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) if (r.selector === selector && r.atRule === null) Object.assign(out, r.decls);
  return out;
}

const exeCss = flatten(join(desktopDir, "src", "index.css"));
const webCss = flatten(join(repoDir, "app", "globals.css"));

describe("the desktop's html scroll-padding", () => {
  it("the walk finds what it should, so the checks below cannot pass for nothing", () => {
    const all = exeCss.flatMap((r) => Object.keys(r.decls));
    expect(all).toContain("--header-h"); // theme.css, through the chain
    expect(exeCss.some((r) => r.selector === ".spotlight")).toBe(true); // stage.css
    // and the web file's own rule, which the desktop numbers are compared with
    expect(cascaded(webCss, "html")["scroll-padding-top"]).toBeTruthy();
  });

  it("is in the CSS the .exe loads: top clears the 56px header row + the offline strip", () => {
    expect(cascaded(exeCss, "html")["scroll-padding-top"]).toBe(
      "calc(56px + var(--offline-strip-h, 0px) + 8px)"
    );
  });

  it("bottom keeps 12px of air (no tab bar), and a page with a sticky save bar adds its height", () => {
    expect(cascaded(exeCss, "html")["scroll-padding-bottom"]).toBe("12px");
    expect(cascaded(exeCss, "html:has(.has-action-bar)")["scroll-padding-bottom"]).toBe("calc(12px + 76px)");
  });

  it("is a top-level rule: the desktop header is 56px at EVERY width, there is no lg switch", () => {
    const mine = exeCss.filter((r) => r.selector === "html" || r.selector === "html:has(.has-action-bar)");
    const scrolling = mine.filter((r) => Object.keys(r.decls).some((p) => p.startsWith("scroll-padding")));
    expect(scrolling.length).toBeGreaterThanOrEqual(2);
    for (const r of scrolling) expect(r.atRule).toBeNull();
  });

  it("the :has() rule stands alone — a selector list would be dropped whole where :has() cannot parse", () => {
    const hasRules = exeCss.filter((r) => r.selector.includes(":has(") && "scroll-padding-bottom" in r.decls);
    expect(hasRules.length).toBeGreaterThan(0);
    for (const r of hasRules) expect(r.selector).not.toContain(",");
  });

  it("uses literals, not the header/tab-bar tokens: <html> reads theme.css's PHONE values", () => {
    // The shell sets its 56px / 0px on a frame below <html>; var(--header-h) written at
    // html level would resolve to the phone header's 52px and var(--tabbar-h) to 58px.
    const mine = [cascaded(exeCss, "html"), cascaded(exeCss, "html:has(.has-action-bar)")];
    for (const d of mine) {
      for (const v of Object.values(d)) {
        expect(v).not.toMatch(/var\(--header-h\)/);
        expect(v).not.toMatch(/var\(--tabbar-h\)/);
      }
    }
  });

  it("the 56px is the header row the Shell really draws (its own --header-h, an h-14 row)", () => {
    const shell = read("src", "components", "shell.tsx");
    // (no brackets in the pattern: Tailwind scans this file too, and would take a
    // bracketed one for a real arbitrary-property class)
    expect(new RegExp("--header-h:(\\d+)px").exec(shell)?.[1]).toBe("56");
    expect(shell).toMatch(/className="container flex h-14 items-center/);
  });

  it("matches the web's own numbers for the same chrome (8px / 12px air, the 76px save bar)", () => {
    // app/globals.css's lg block restates the desktop-like case (56px header, no tab bar).
    const web = webCss.filter((r) => r.atRule === "media (min-width: 1024px)");
    const px = (v: string) => [...v.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
    const webTop = web.find((r) => r.selector === "html")!.decls["scroll-padding-top"];
    const webBottom = web.find((r) => r.selector === "html")!.decls["scroll-padding-bottom"];
    const webBar = web.find((r) => r.selector === "html:has(.has-action-bar)")!.decls["scroll-padding-bottom"];
    const mineHtml = cascaded(exeCss, "html");
    const mineBar = cascaded(exeCss, "html:has(.has-action-bar)")["scroll-padding-bottom"];
    // top: 56 + 8 (the strip is a var(), the notch an env() — neither is a px literal)
    expect(px(mineHtml["scroll-padding-top"])).toEqual(px(webTop));
    // bottom: the web's 12px of air; the bar variant adds its 76px on top of that
    expect(px(mineHtml["scroll-padding-bottom"])).toEqual(px(webBottom));
    expect(px(mineBar)).toEqual(px(webBar));
  });
});
