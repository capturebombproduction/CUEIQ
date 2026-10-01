import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type AtRule, type Rule } from "postcss";
import { relativeLuminance, SPOT_LUM_MAX } from "@/lib/skin";

// ─────────────────────────────────────────────────────────────────────────────
// THE LIGHT (redesign v3 "Stage Wash", review-shots/design/FINAL-SPEC-v3.md §E.1).
//
// Round 3 replaced exactly one layer of v2: the background and the light. What is
// left is deliberately small and static — ONE page light (.spotlight: three smooth
// radials — vignette, hot core, long throw) and ONE glowing hero (.lit: a band glow
// from the key edge). The founder's brief was "ง่ายตาเหมือนรอบ 1 แต่ดูดีและดุกว่า", and
// every way this layer could drift back toward v2 (cones, wedges, halftone, ghost
// words), toward noise (blur, texture), or toward motion is pinned here. jsdom has no
// CSS, so the rules themselves are the subject.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, "..");
const STAGE = path.join(repoRoot, "app/stage.css");
const THEME = path.join(repoRoot, "app/theme.css");
const stage = postcss.parse(fs.readFileSync(STAGE, "utf8"), { from: STAGE });

const flat = (v: string) => v.replace(/\s+/g, " ").trim();

/** Every rule whose selector list contains `selector` exactly, with the at-rule it
 *  sits in ("" at the top level). */
function rulesFor(selector: string): { rule: Rule; media: string }[] {
  const out: { rule: Rule; media: string }[] = [];
  stage.walkRules((rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    const parent = rule.parent as AtRule | undefined;
    out.push({ rule, media: parent?.type === "atrule" ? `@${parent.name} ${parent.params}` : "" });
  });
  return out;
}

/** The declarations of the top-level rule(s) for `selector`, later ones winning. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { rule, media } of rulesFor(selector)) {
    if (media) continue;
    rule.walkDecls((d) => void (out[d.prop] = flat(d.value)));
  }
  return out;
}

describe(".spotlight — the ONE page light", () => {
  const d = decls(".spotlight");

  it("is a viewport-sized layer that never takes a tap and sits behind the content", () => {
    expect(d.position, "fixed: it must not scroll away and end in a seam").toBe("fixed");
    expect(d.inset).toBe("0");
    expect(d["pointer-events"]).toBe("none");
    // -1, not the spec's 0: StageLight is a SIBLING of in-flow content on the Live
    // screens (inside .live-root, so .zone-over can reach it). At 0 a positioned
    // layer paints OVER every non-positioned sibling — the vignette at .9 would sink
    // the status row and the NEXT card into black. At -1 it paints right above the
    // nearest stacking context's own background and under everything in it.
    expect(d["z-index"]).toBe("-1");
  });

  // The spec's three radials, every centre lifted 47 px (-12 % / 30 px / -90 px →
  // calc(-12% - 47px) / -17px / -137px). The spec's numbers were tuned on mockup
  // phones whose 47 px iOS status bar sat INSIDE the lit box; in the app the header
  // starts at y 0, so unlifted, every page meta and the Live status row sat 47 px
  // deeper in the hot core than the approved mockup (probe: home meta 3.86–4.10:1
  // against the spec's ≥ 4.6; lifted, 4.54–4.70 and the mockup's own pixels).
  it("is the spec's three static radials, lifted by the mockup's status bar, and nothing else", () => {
    expect(d.background).toBeUndefined();
    expect(d["background-image"]).toBe(
      flat(`
      radial-gradient(ellipse 118% 94% at var(--spot-x, 50%) calc(-12% - 47px), transparent 46%, hsl(var(--shadow) / calc(var(--vig-a) * .5)) 74%, hsl(var(--shadow) / var(--vig-a)) 100%),
      radial-gradient(ellipse 320px 290px at var(--spot-x, 50%) -17px, hsl(var(--spot) / var(--spot-core-a)) 0%, hsl(var(--spot) / calc(var(--spot-core-a) * .56)) 34%, hsl(var(--spot) / calc(var(--spot-core-a) * .18)) 68%, hsl(var(--spot) / 0) 100%),
      radial-gradient(ellipse 560px 1120px at var(--spot-x, 50%) -137px, hsl(var(--spot) / var(--spot-a)) 0%, hsl(var(--spot) / calc(var(--spot-a) * .62)) 26%, hsl(var(--spot) / calc(var(--spot-a) * .26)) 54%, hsl(var(--spot) / calc(var(--spot-a) * .08)) 78%, hsl(var(--spot) / 0) 100%)`)
    );
  });

  it("never moves, blurs or textures (spec §0.3 rule 1, §H, §I)", () => {
    // both rules: the layer's own, and the radials it shares with .lit-bar::before
    expect(rulesFor(".spotlight").length, "no .spotlight rule — this would pass on nothing").toBeGreaterThanOrEqual(2);
    for (const { rule } of rulesFor(".spotlight")) {
      rule.walkDecls((decl) => {
        expect(decl.prop, `.spotlight ${decl.prop}`).not.toMatch(/^(animation|transition|filter|backdrop-filter|mask|-webkit-mask|will-change)/);
        expect(decl.value, `.spotlight ${decl.prop}`).not.toMatch(/conic-gradient|repeating-|url\(|blur\(/);
      });
    }
  });

  it("overtime swaps the light to the neutral alarm light — element-scoped, never a skin token", () => {
    expect(decls(".zone-over")["--spot"]).toBe("var(--alarm)");
    expect(decls(":root:not(.dark) .zone-over .spotlight").opacity).toBe(".5");
  });

  // The dark --alarm is the L88 plate colour (luminance ≈ .75). Thrown as the page
  // light, its hot core turned the Live top bar and status row light grey and the
  // green "เสียงออกเครื่องนี้" chip fell to 1.9:1 — at the loudest moment of the show.
  // The overtime light is capped like every band light (lib/skin.ts SPOT_LUM_MAX).
  it("the dark overtime light stays under the same luminance ceiling as every band light", () => {
    const darkAlarm = /\.dark\s*\{[^}]*?--alarm:\s*([^;]+);/.exec(fs.readFileSync(THEME, "utf8"))?.[1].trim();
    expect(darkAlarm).toBeTruthy();
    const resolve = (v: string | undefined) => (v === "var(--alarm)" ? darkAlarm! : v);
    const darkOver = resolve(decls(".dark .zone-over")["--spot"] ?? decls(".zone-over")["--spot"]);
    expect(darkOver).toMatch(/^\d+ \d+% \d+%$/);
    expect(relativeLuminance(darkOver!)).toBeLessThanOrEqual(SPOT_LUM_MAX);
    // still a work light, not a dimmed-out one: a neutral grey near the ceiling
    expect(darkOver).toMatch(/^0 0% /);
    expect(relativeLuminance(darkOver!)).toBeGreaterThan(SPOT_LUM_MAX * 0.75);
  });
});

// An opaque sticky bar in the hot core (the Event page's segmented tabs) cut a flat
// unlit band through the light. It stays solid (§0.3 rule 2) but repeats the light.
describe(".lit-bar — an opaque bar that carries the page light", () => {
  it("paints the SAME radials as the page light, fixed to the viewport, clipped to the bar", () => {
    const shared = rulesFor(".lit-bar::before").filter((r) => !r.media).map((r) => r.rule);
    // one of its rules is the .spotlight's own radial rule — never a copy that drifts
    expect(shared.some((r) => r.selectors.map((s) => s.trim()).includes(".spotlight"))).toBe(true);
    const before = decls(".lit-bar::before");
    expect(before["background-image"]).toBe(decls(".spotlight")["background-image"]);
    expect(before.position).toBe("fixed");
    expect(before.inset).toBe("0");
    expect(before["z-index"]).toBe("-1");
    expect(before["pointer-events"]).toBe("none");
    // opaque: the page colour under the light, so nothing scrolls through it
    expect(before["background-color"]).toBe("hsl(var(--background))");
    // clip-path (iOS ignores background-attachment: fixed) keeps it inside the bar
    expect(decls(".lit-bar")["clip-path"]).toBe("inset(0)");
  });

  it("is what the Event page's sticky tab strip wears, with no flat fill of its own", () => {
    const src = fs.readFileSync(path.join(repoRoot, "components/event/event-workspace.tsx"), "utf8");
    const strip = /className="([^"]*\bsticky\b[^"]*)"/.exec(src)?.[1] ?? "";
    expect(strip.split(/\s+/)).toContain("lit-bar");
    expect(strip).toMatch(/\bz-30\b/); // its stacking context: the ::before's -1 stays inside it
    expect(strip).not.toMatch(/(^|\s)bg-/);
  });
});

describe(".lit — the ONE glowing hero", () => {
  const d = decls(".lit");

  it("glows in --lit-g, which defaults to the stage light and follows a zone's --lit", () => {
    expect(d["--lit-g"]).toBe("var(--lit, var(--spot))");
    expect(d["--lit-c"]).toBe("var(--lit, var(--primary))");
    expect(d.background).toMatch(/hsl\(var\(--lit-g\) \/ calc\(var\(--glow-a\) \* \.6 \* var\(--glow-k, 1\)\)\) 0, /); // key-edge bloom
    expect(d.background).toMatch(/radial-gradient\(ellipse 66% 150px at 50% -40px, hsl\(var\(--lit-g\)/); // the lip
    expect(d.background).toMatch(/radial-gradient\(ellipse 140% 92% at 50% -18%, hsl\(var\(--lit-g\)/); // the body
    expect(d.background.endsWith("hsl(var(--card))")).toBe(true);
  });

  it("lifts the secondary text that sits in the glow (≥ 4.5:1 over its hottest part)", () => {
    expect(d["--muted-foreground"]).toBe("var(--lit-muted-foreground)");
  });

  it("carries no wedge, no halftone and no ::before layer (v2's, removed)", () => {
    expect(d.background).not.toMatch(/conic-gradient|repeating-|radial-gradient\(circle/);
    expect(rulesFor(".lit::before")).toEqual([]);
  });

  it("zones dim the glow through --glow-k: WARN .62, URGENT .3 under the wash", () => {
    expect(decls(".now.zone-warn")["--glow-k"]).toBe(".62");
    expect(decls(".now.zone-urgent")["--glow-k"]).toBe(".3");
  });

  // Dark WARN's header row is amber text (≤0:46, 02 / 16) and the lifted "จบ" on an
  // amber strip over the amber glow: 3.6–4.0:1 for every preset at .62 / .17. Dark
  // only (light WARN's ink is dark, and its strip was the venue's "too faint" fix).
  it("dark WARN lowers the glow and thins the strip under its header row", () => {
    expect(Number(decls(".dark .now.zone-warn")["--glow-k"])).toBeLessThanOrEqual(0.45);
    const tint = /hsl\(var\(--warning\) \/ (0?\.\d+)\)/.exec(decls(".dark .zone-warn .zhead").background ?? "");
    expect(tint).not.toBeNull();
    expect(Number(tint![1])).toBeLessThanOrEqual(0.13);
    // light keeps the spec's strip
    expect(decls(".zone-warn .zhead").background).toMatch(/hsl\(var\(--warning\) \/ \.17\)/);
  });

  // v2 bug: with motion off the animation was killed and the sweep's skewed START
  // pose stayed painted as a pale wedge on the hero — for real reduced-motion users.
  it("with motion off the sweep is not painted at all, by either switch", () => {
    const qa = rulesFor("html.reduce-motion .lit.sweep::after");
    expect(qa.map((r) => r.rule.toString())).toEqual([expect.stringMatching(/display:\s*none/)]);
    const media = rulesFor(".lit.sweep::after").filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.media));
    expect(media.map((r) => r.rule.toString())).toEqual([expect.stringMatching(/display:\s*none/)]);
  });
});

describe("no light texture, ghost word or cone anywhere (spec §A.1, §I)", () => {
  it("stage.css draws none", () => {
    const css = fs.readFileSync(STAGE, "utf8");
    expect(css).not.toMatch(/conic-gradient/);
    expect(css).not.toMatch(/attr\(data-ghost\)|\.page-title::before|\.cone\b/);
    // the only filters are the two glass bars' backdrop blur
    const blurs: string[] = [];
    stage.walkDecls(/filter$/, (decl) => void blurs.push(`${(decl.parent as Rule).selector} ${decl.prop}`));
    expect(blurs.every((b) => /^\.glass /.test(b) && /backdrop-filter$/.test(b))).toBe(true);
  });

  it("no screen paints a conic wedge or a ghost word of its own", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "node_modules" || e.name === "zz-gallery" ? [] : walk(rel);
        return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const hits = ["components", "app", "lib", "desktop/src"].flatMap(walk).flatMap((f) =>
      fs
        .readFileSync(path.join(repoRoot, f), "utf8")
        .split(/\r?\n/)
        .flatMap((line, i) => (/conic-gradient|data-ghost|stage-cone|StageCone/.test(line) ? [`${f}:${i + 1}`] : []))
    );
    expect(hits).toEqual([]);
  });
});
