// Round 15, wave 3 · three stylesheet decisions, pinned as the sheets' own text (app/stage.css,
// app/theme.css) plus the real elements they must reach. jsdom has no layout: what is held here is the
// rules, the tokens and the arithmetic; a real browser still has to look (what to measure is in each block).
//
// This file sits under test/web on purpose: app/ and components/ are Tailwind content globs, and a word in
// a comment there can generate a utility nobody wrote (a stray rule shipped from a comment once already).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type AtRule, type Rule } from "postcss";
import { render } from "@testing-library/react";
import { NowCard } from "@/components/live/now-card";
import type { LiveZone } from "@/lib/live-zone";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const stage = postcss.parse(read("app/stage.css"));
const theme = postcss.parse(read("app/theme.css"));

const flat = (v: string) => v.replace(/\s+/g, " ").trim();
const norm = (v: string) => v.replace(/\s+/g, "");
const ancestors = (node: postcss.ChildNode): AtRule[] => {
  const out: AtRule[] = [];
  for (let p: postcss.Node["parent"] = node.parent; p && p.type === "atrule"; p = p.parent) out.unshift(p as AtRule);
  return out;
};
/** the ancestry as one whitespace-free string ("" = top level) */
const chainOf = (node: postcss.ChildNode) => ancestors(node).map((a) => norm(`@${a.name}${a.params}`)).join(">");
const sels = (rule: Rule) => rule.selectors.map(flat);
/** declarations of every rule for `selector` at one at-rule chain ("" = top level) */
function decls(selector: string, chain = ""): Record<string, string> {
  const out: Record<string, string> = {};
  stage.walkRules((r) => {
    if (sels(r).includes(selector) && chainOf(r) === chain) r.walkDecls((d) => void (out[d.prop] = flat(d.value)));
  });
  return out;
}
/** a theme.css top-level token rule's custom properties (the first rule with that exact selector) */
function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  let done = false;
  theme.each((n) => {
    if (done || n.type !== "rule" || n.selector !== selector) return;
    n.walkDecls((d) => void (d.prop.startsWith("--") && (out[d.prop] = flat(d.value))));
    done = true;
  });
  return out;
}
/** the tokens of the @media print block (one rule, html:root / html.dark) */
function printTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  theme.walkAtRules("media", (m) => {
    if (m.params !== "print") return;
    m.walkRules((r) => {
      if (r.selectors.some((s) => s.trim() === "html:root")) r.walkDecls((d) => void (d.prop.startsWith("--") && (out[d.prop] = flat(d.value))));
    });
  });
  return out;
}

// ── CQ-52 · the BOTTOM tab bar is more opaque glass, and its labels are legible ───────────────────────
// Over a bright page (the Summary's Google map) the bar's .7 dark glass let the map through, and its inactive
// labels (--faint-foreground) fell under 4.5:1. The owner approved: the bottom bar ONLY gets about .84 dark /
// .9 light, and the inactive labels read --muted-foreground. The header keeps its glass; so does Live's dock.
// MEASURE (real browser, 390 phone, dark + light): the Summary tab scrolled so the map sits under the bar,
// the four labels against the pixels behind them, p5 >= 4.5.
describe("the bottom tab bar's glass (CQ-52)", () => {
  const TAB_BAR = "nav.glass-bottom";
  const light = tokens(":root");
  const dark = tokens(".dark");

  it("has its own, more opaque alpha: .9 in light, .84 in dark; flat (1) in an export and on paper", () => {
    expect(Number(light["--tabbar-glass-a"])).toBeGreaterThanOrEqual(0.9);
    expect(Number(dark["--tabbar-glass-a"])).toBeGreaterThanOrEqual(0.84);
    // a JPG and a sheet of paper are flat, like every other knob (lib/theme-single-source.test.ts holds the rest)
    expect(tokens(".export-light")["--tabbar-glass-a"]).toBe("1");
    expect(printTokens()["--tabbar-glass-a"]).toBe("1");
  });

  it("the header's glass is untouched: --glass-a keeps .86 light / .7 dark", () => {
    expect(light["--glass-a"]).toBe("0.86");
    expect(dark["--glass-a"]).toBe("0.7");
  });

  it("only the tab bar reads it, through the --glass-a every glass bar already uses", () => {
    expect(decls(TAB_BAR)["--glass-a"]).toBe("var(--tabbar-glass-a)");
    // not a background of its own: the no-backdrop-filter fallback (.97) must keep winning over the bar
    expect(decls(TAB_BAR)["background-color"]).toBeUndefined();
    expect(decls(".glass")["background-color"]).toBe("hsl(var(--background) / var(--glass-a))");
  });

  it("inactive labels read --muted-foreground, the lit one stays --foreground", () => {
    expect(decls(".tab").color).toBe("hsl(var(--muted-foreground))");
    expect(decls(".tab[aria-current=page]").color).toBe("hsl(var(--foreground))");
  });

  // sRGB channels (0..1) of a token triplet ("240 6% 32%")
  const rgb = (t: string): [number, number, number] => {
    const [h, s, l] = t.split(/\s+/).map((p) => parseFloat(p));
    const S = s / 100;
    const L = l / 100;
    const a = S * Math.min(L, 1 - L);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  };
  const lum = ([r, g, b]: number[]) => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const over = (top: number[], a: number, behind: number[]) => top.map((c, i) => c * a + behind[i] * (1 - a));
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  /** the token the .tab rule colours inactive labels with, and the alpha the bar's glass really has */
  const labelToken = () => /hsl\(var\((--[\w-]+)\)\)/.exec(decls(".tab").color ?? "")?.[1] ?? "";
  const alphaOf = (palette: Record<string, string>) => {
    const named = /var\((--[\w-]+)\)/.exec(decls(TAB_BAR)["--glass-a"] ?? "")?.[1] ?? "--glass-a";
    return Number(palette[named]);
  };

  // The worst page under a glass bar is the opposite of the theme: pure white behind the dark bar, pure black
  // behind the light one (blur and saturation never leave the extremes). If the label holds there it holds on
  // every map, photo and banner the Summary can put behind it.
  const THEMES: [string, Record<string, string>, number[]][] = [
    ["dark", dark, [1, 1, 1]],
    ["light", light, [0, 0, 0]],
  ];
  it.each(THEMES)("%s: an inactive label reads >= 4.5:1 on the glass over the worst page", (_theme, palette, worst) => {
    const label = palette[labelToken()];
    expect(label, `the .tab colour names ${labelToken()}, which this palette does not define`).toBeTruthy();
    const glass = over(rgb(palette["--background"]), alphaOf(palette), worst);
    expect(ratio(rgb(label), glass)).toBeGreaterThanOrEqual(4.5);
  });
});

// ── CQ-61 · the OVERTIME next-invite ring pulses for ~6 s, then holds ──────────────────────────────────
// An infinite smooth tween kept the compositor at ~60 frames a second for as long as the show stayed in
// overtime (the phone's battery in the worst minutes of a show). It now pulses at the SAME 1.2 s period for
// about 6 s and rests at the lit state reduced motion already shows all the time (.9).
// MEASURE: the ring's computed opacity at 0.3 s (mid-pulse), 7 s and 20 s: the last two equal .9.
describe("the NEXT invite ring runs for a while, then holds (CQ-61)", () => {
  const RING = ".next-invite::after";
  const anim = () => {
    const raw = decls(RING).animation ?? "";
    const t = raw.replace(/var\([^)]*\)/g, " ").trim().split(/\s+/);
    const time = t.find((x) => /^\d*\.?\d+m?s$/.test(x));
    return {
      raw,
      name: t[0],
      seconds: time ? parseFloat(time) / (time.endsWith("ms") ? 1000 : 1) : NaN,
      count: t.find((x) => /^(infinite|\d*\.?\d+)$/.test(x)) ?? "1",
      fill: t.find((x) => /^(none|forwards|backwards|both)$/.test(x)) ?? "none",
    };
  };
  /** the @keyframes' stops, by percentage */
  const stops = (name: string) => {
    const out: { at: number; opacity: number }[] = [];
    stage.walkAtRules("keyframes", (k) => {
      if (k.params !== name) return;
      k.walkRules((r) => {
        const op = r.nodes.find((n): n is postcss.Declaration => n.type === "decl" && n.prop === "opacity");
        if (!op) return;
        for (const s of r.selectors) out.push({ at: s.trim() === "from" ? 0 : s.trim() === "to" ? 100 : parseFloat(s), opacity: Number(op.value) });
      });
    });
    return out.sort((a, b) => a.at - b.at);
  };

  it("is finite: no `infinite`, and about six seconds in all", () => {
    const a = anim();
    expect(a.name).toBe("next-invite");
    expect(a.count, a.raw).not.toBe("infinite");
    const total = a.seconds * Number(a.count);
    expect(total, a.raw).toBeGreaterThanOrEqual(5);
    expect(total, a.raw).toBeLessThanOrEqual(7);
  });

  it("pulses at the period it always had (1.2 s) at least four times", () => {
    const a = anim();
    const peaks = stops("next-invite").filter((s) => s.opacity === 1);
    expect(peaks.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < peaks.length; i++) {
      expect(((peaks[i].at - peaks[i - 1].at) / 100) * a.seconds * Number(a.count), `peak ${i}`).toBeCloseTo(1.2, 2);
    }
    // and the dark half of each pulse is still the .2 it was
    expect(stops("next-invite")[0]).toEqual({ at: 0, opacity: 0.2 });
  });

  it("ends lit: the last stops are .9, the animation fills forwards, and the ring rests at .9 on its own", () => {
    const s = stops("next-invite");
    expect(s.at(-1)).toEqual({ at: 100, opacity: 0.9 });
    expect(s.at(-2)?.opacity, "the ring must have stopped moving before the animation ends").toBe(0.9);
    expect(anim().fill).toMatch(/^(forwards|both)$/);
    expect(decls(RING).opacity).toBe(".9");
  });

  it("reduced motion is as it was: no animation at all, and the same static .9 ring", () => {
    expect(decls("html.reduce-motion .next-invite::after").opacity).toBe(".9");
    expect(decls(RING, "@media(prefers-reduced-motion:reduce)").opacity).toBe(".9");
    // the app-wide switch that kills every animation for both of them
    expect(decls("html.reduce-motion *::after").animation).toBe("none");
  });
});

// ── the OK-zone NOW strip drops its index before it would cut the clock (r15 final verification) ──────
// `.zend` is overflow: hidden (a clock must clip before anything wraps), so a strip too narrow for
// tag + index + clock shows a PARTIAL time: a believable wrong one. WARN and URGENT shed in order down a
// container-query ladder (components/live/now-card.test.tsx); OK had no rung, and on a stage window
// 900-908 px wide the OK strip's "จบ 17:45:30" was cut. OK sheds its index at need + ~4 px, like the rest.
// Measured in Chromium with Barlow Condensed + Kanit loaded (review-shots/r15/_measure/now-strip2/
// okover-before): the "Now" tag 62.27, the index 44.92, the clock 73.89, two 9 px gaps.
// MEASURE: OK at a stage window 900, 904 and 908 wide, and just either side of the strip's 203 px content
// width: `.zend` scrollWidth <= clientWidth; at 1000+ the index is still there.
describe("NowCard · the OK strip sheds its index from its own width", () => {
  const W = { tagOk: 62.27, idx: 44.92, clock: 73.89 };
  const NEED = W.tagOk + W.idx + W.clock + 2 * 9; // 199.08: tag, index, clock and the two gaps between them
  const MARGIN: [number, number] = [3, 6]; // "~4 px", as every rung of the WARN / URGENT ladder

  /** the @container rules that hide `.zidx`, as [max-width, selector] */
  const idxRungs = () => {
    const out: { max: number; selector: string }[] = [];
    stage.walkAtRules("container", (at) => {
      at.walkRules((r) => {
        let hides = false;
        r.walkDecls("display", (d) => void (flat(d.value) === "none" && (hides = true)));
        if (!hides) return;
        for (const s of sels(r)) if (/\.zidx$/.test(s)) out.push({ max: parseFloat(/max-width:\s*([\d.]+)px/.exec(at.params)![1]), selector: s });
      });
    });
    return out;
  };
  const okRung = () => {
    const hits = idxRungs().filter((r) => r.selector.includes("data-zone=ok"));
    expect(hits, "one @container rung hides the OK zone's index").toHaveLength(1);
    return hits[0];
  };
  const card = (zone: LiveZone) => {
    const { container, unmount } = render(
      <NowCard zone={zone} blockSec={92} remaining={zone === "over" ? -4 : 40} elapsed={50} index={2} total={16}
        kind="se" title="Opening SE" note={null} endClock="18:05:25" canAdvance />
    );
    return { el: container.querySelector("section[data-zone]") as HTMLElement, unmount };
  };

  it("sits at what tag + index + clock need, + ~4 px", () => {
    const margin = okRung().max - NEED;
    expect(margin, `${okRung().max} vs needs ${NEED.toFixed(2)}`).toBeGreaterThanOrEqual(MARGIN[0]);
    expect(margin, `${okRung().max} vs needs ${NEED.toFixed(2)}`).toBeLessThanOrEqual(MARGIN[1]);
  });

  it("is the narrowest thing the strip loses: tag + clock still fit where the index is gone", () => {
    expect(okRung().max).toBeGreaterThan(W.tagOk + W.clock + 9); // 145.16: below it the clock would clip anyway
  });

  it("reaches the OK card's index, and never WARN's, URGENT's, or overtime's", () => {
    const selector = okRung().selector;
    const reached: Record<string, number> = {};
    for (const z of ["ok", "warn", "urgent", "over"] as LiveZone[]) {
      const { el, unmount } = card(z);
      reached[z] = Array.from(el.querySelectorAll(".zidx")).filter((i) => i.matches(selector)).length;
      unmount();
    }
    expect(reached).toEqual({ ok: 1, warn: 0, urgent: 0, over: 0 });
  });

  it("is the only rung the OK zone has, and leaves the WARN / URGENT ladder as it was", () => {
    const rungs = idxRungs();
    expect(rungs.map((r) => r.selector).sort()).toEqual([".now[data-zone=ok] .zidx", ".zone-urgent .zidx", ".zone-warn .zidx"]);
    expect(rungs.find((r) => r.selector === ".zone-urgent .zidx")?.max).toBe(240);
    expect(rungs.find((r) => r.selector === ".zone-warn .zidx")?.max).toBe(236);
  });
});
