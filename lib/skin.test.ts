import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { ACCENT_PRESETS } from "@/lib/accent";
import {
  SPOT_LUM_MAX,
  THEME_DESTRUCTIVE_HUES,
  contrast,
  hexToHsl,
  relativeLuminance,
  skinCss,
  spotFor,
} from "@/lib/skin";

// A band colour lands under or around text in five places: the primary fill (buttons,
// solid chips, the title slab), the band colour AS text (--primary-ink), the field
// boundary (--input), and the delete red next to it (--destructive). Each is walked
// to a WCAG ratio by lib/skin.ts; these hold every preset, both themes, to it — and a
// sweep of the whole colour wheel, because a band can pick ANY colour.
//
// v3 "Stage Wash" (FINAL-SPEC-v3 §C) adds the sixth: the stage light, --spot. In dark
// it is walked DOWN to a relative luminance of SPOT_LUM_MAX, so every band throws the
// same amount of light and text over the hot core keeps the same contrast in every
// preset (SK Green's raw spot was .67 — a neon field). And band text is measured
// against the LIT surfaces: the band-washed light page, and the dark hero top under
// the glow (≈ the card at L13).

const BANDS: [string, string][] = [
  ...ACCENT_PRESETS.map((p): [string, string] => [p.name, p.hex]),
  ["Hoshizora", "#2f7fd6"], // a real band colour, not a preset: just clears AA
];

type Theme = "light" | "dark";
/** skinCss() → its :root (light) and .dark declarations. */
function parseSkin(css: string): Record<Theme, Record<string, string>> {
  const out = { light: {}, dark: {} } as Record<Theme, Record<string, string>>;
  for (const m of css.matchAll(/(:root|\.dark)\{([^}]*)\}/g)) {
    const into = out[m[1] === ":root" ? "light" : "dark"];
    for (const d of m[2].split(";").filter(Boolean)) {
      const i = d.indexOf(":");
      into[d.slice(0, i)] = d.slice(i + 1);
    }
  }
  return out;
}

/** app/theme.css's own tokens, per theme: what a device with NO band skin shows. */
const themeTokens = (() => {
  const root = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../app/theme.css"), "utf8"));
  const out: Record<Theme, Record<string, string>> = { light: {}, dark: {} };
  root.each((n) => {
    if (n.type !== "rule") return;
    const theme = n.selector === ":root" ? "light" : n.selector === ".dark" ? "dark" : null;
    if (theme) n.walkDecls(/^--/, (d) => void (out[theme][d.prop] = d.value));
  });
  return out;
})();
/** --destructive as app/theme.css sets it, per theme (what a skin that leaves it alone shows). */
const themeDestructive: Record<Theme, string> = {
  light: themeTokens.light["--destructive"],
  dark: themeTokens.dark["--destructive"],
};

/** theme.css's --destructive-foreground (no skin writes it): the text on a delete fill. */
const WHITE_TRIPLET = "0 0% 100%";

const hueOf = (triplet: string) => parseFloat(triplet);
const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
/** The same hue and saturation at another lightness: "6 24% 9%" → "6 24% 13%". */
const atL = (triplet: string, l: number) => triplet.trim().split(/\s+/).slice(0, 2).concat(`${l}%`).join(" ");

/** Where band TEXT really sits in each theme (spec §C): the light page (band-washed,
 *  darker than the white card, so it binds), and the dark hero top under the glow —
 *  the card's own hue and wash, lifted to L13. */
const litSurface = (theme: Theme, t: Record<string, string>) =>
  theme === "light" ? t["--background"] : atL(t["--card"], 13);

/** Every WCAG promise the skin makes, for one band colour; [] when all hold. */
function failures(hex: string): string[] {
  const { s } = hexToHsl(hex);
  const skin = parseSkin(skinCss(hex));
  const bad: string[] = [];
  const need = (what: string, ratio: number, min: number) => {
    if (!(ratio >= min)) bad.push(`${hex} ${what} ${ratio.toFixed(2)} < ${min}`);
  };
  for (const theme of ["light", "dark"] as const) {
    const t = skin[theme];
    need(`${theme} on-primary`, contrast(t["--primary-foreground"], t["--primary"]), 4.5);
    need(`${theme} primary-ink on card`, contrast(t["--primary-ink"], t["--card"]), 4.5);
    need(`${theme} primary-ink on the lit surface`, contrast(t["--primary-ink"], litSurface(theme, t)), 4.5);
    need(`${theme} input on card`, contrast(t["--input"], t["--card"]), 3);
    need(`${theme} input on page`, contrast(t["--input"], t["--background"]), 3);
    if (!t["--spot"]) bad.push(`${hex} ${theme} carries no --spot`);
    // The dark light is capped; the light theme's is a low-alpha tint and needs none.
    if (theme === "dark" && t["--spot"] && !(relativeLuminance(t["--spot"]) <= SPOT_LUM_MAX)) {
      bad.push(`${hex} dark --spot ${t["--spot"]} luminance ${relativeLuminance(t["--spot"]).toFixed(3)} > ${SPOT_LUM_MAX}`);
    }
    // A grey band has no hue for the delete red to be confused with.
    if (s >= 15) {
      const destructive = t["--destructive"] ?? themeDestructive[theme];
      const dist = hueDist(hueOf(destructive), hexToHsl(hex).h);
      if (dist < 45) bad.push(`${hex} ${theme} destructive ${destructive} only ${dist}° from the band`);
    }
    // The moved delete red is a glyph and a fill on THAT theme's surfaces: the trash
    // icon, Ban / X, the save-failed mark and the error toast's rail (3:1, WCAG 1.4.11),
    // and the white on the filled delete button (AA). One 44 % red served both themes
    // until CQ-14 — right on a white card, 2.0-2.4:1 on the 5-13 % dark ones.
    if (t["--destructive"]) {
      for (const surface of ["--background", "--card", "--popover", "--muted"]) {
        need(`${theme} destructive on ${surface}`, contrast(t["--destructive"], t[surface]), 3);
      }
      need(`${theme} white on the destructive fill`, contrast(WHITE_TRIPLET, t["--destructive"]), 4.5);
    }
  }
  return bad;
}

const hslHex = (h: number, s: number, l: number) => {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

describe("contrast()", () => {
  it("measures WCAG ratios (or every check below is meaningless)", () => {
    expect(contrast("0 0% 100%", "0 0% 0%")).toBeCloseTo(21, 5);
    expect(contrast("0 0% 50%", "0 0% 50%")).toBe(1);
    expect(contrast("0 0% 100%", "240 100% 50%")).toBeCloseTo(8.59, 2); // #0000ff on white
    expect(contrast("0 0% 46%", "0 0% 100%")).toBeCloseTo(4.6, 1); // ≈ #767676, the AA grey
  });
});

describe("skinCss() holds WCAG for every band preset, both themes", () => {
  it.each(BANDS)("%s %s", (_, hex) => {
    expect(failures(hex)).toEqual([]);
  });

  it("Seishin's delete red moves off the band red (to violet)", () => {
    const skin = parseSkin(skinCss("#a62a1c"));
    expect(hueOf(skin.light["--destructive"])).toBe(265);
    expect(hueOf(skin.dark["--destructive"])).toBe(265);
  });

  // CQ-14: the violet is one hue but TWO lightnesses. Light keeps 44 % (8:1 white on
  // it, 7:1+ on the page); dark is lifted to 60 % — at 44 % it was 2.2:1 on the dark
  // card, and the trash icons, Ban / X and the error toast's rail all but vanished.
  it("the moved delete red is lighter in dark than in light, the same violet", () => {
    const skin = parseSkin(skinCss("#a62a1c"));
    expect(skin.light["--destructive"]).toBe("265 68% 44%");
    expect(skin.dark["--destructive"]).toBe("265 68% 60%");
    // the dark one clears the bar the old shared 44 % missed (it was 2.19 on the card)
    expect(contrast(skin.dark["--destructive"], skin.dark["--card"])).toBeGreaterThanOrEqual(3.5);
    expect(contrast("265 68% 44%", skin.dark["--card"])).toBeLessThan(3);
  });

  // Every preset whose skin moves the red (Seishin, Crimson, Sunset, Sakura …), and the
  // whole colour wheel in the sweep below, are held by failures(): this names them so a
  // preset change cannot quietly empty the check.
  it("at least the red / orange / pink presets move --destructive, and are held to 3:1 per theme", () => {
    const moved = BANDS.filter(([, hex]) => parseSkin(skinCss(hex)).dark["--destructive"]);
    expect(moved.length).toBeGreaterThanOrEqual(3);
    for (const [, hex] of moved) {
      const skin = parseSkin(skinCss(hex));
      for (const theme of ["light", "dark"] as const) {
        for (const surface of ["--background", "--card", "--muted"]) {
          expect(contrast(skin[theme]["--destructive"], skin[theme][surface])).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("the skin emits each theme's --destructive inside that theme's own block, and valid CSS", () => {
    const css = skinCss("#a62a1c");
    // exactly one --destructive per block, none dangling outside a block, each ends with ';}'
    expect(css.match(/--destructive:/g)).toHaveLength(2);
    expect(css).toMatch(/^:root\{[^}]*--destructive:265 68% 44%;\}\.dark\{[^}]*--destructive:265 68% 60%;\}$/);
  });

  it("a blue band keeps the theme's own red", () => {
    expect(skinCss("#2563eb")).not.toContain("--destructive");
  });

  // The spec's published output (FINAL-SPEC-v3 §C), byte for byte: the band-washed
  // dark surfaces (page L5 / card L9 / well L13), the soft light-page wash, the ink
  // and the field edge walked against those surfaces, and the stage light.
  it("Seishin's skin is the spec's v3 output, byte for byte", () => {
    expect(skinCss("#a62a1c")).toBe(
      ":root{--primary:6 71% 38%;--ring:6 71% 38%;--primary-foreground:0 0% 100%;--primary-ink:6 71% 38%;" +
        "--accent:6 25% 95%;--accent-foreground:6 71% 30%;--background:6 20% 95%;--card:0 0% 100%;--popover:0 0% 100%;" +
        "--secondary:6 10% 91%;--muted:6 10% 91%;--border:6 10% 80%;--input:6 10% 54%;--spot:6 81% 45%;--destructive:265 68% 44%;}" +
        ".dark{--primary:6 71% 46%;--ring:6 71% 46%;--primary-foreground:0 0% 100%;--primary-ink:6 71% 60%;" +
        "--accent:6 26% 16%;--accent-foreground:0 0% 98%;--background:6 30% 5%;--card:6 24% 9%;--popover:6 24% 11%;" +
        "--secondary:6 18% 13%;--muted:6 18% 13%;--border:6 18% 17%;--input:6 18% 43%;--spot:6 86% 50%;--destructive:265 68% 60%;}"
    );
  });
});

describe("the stage light, --spot (v3)", () => {
  // Seishin's own spot is .196 — under the ceiling, so the band the light was tuned on
  // is untouched by it.
  it("Seishin's dark spot is exactly 6 86% 50%, under the ceiling", () => {
    expect(spotFor("#a62a1c").dark).toBe("6 86% 50%");
    expect(relativeLuminance("6 86% 50%")).toBeLessThanOrEqual(SPOT_LUM_MAX);
    expect(SPOT_LUM_MAX).toBe(0.2);
  });

  // The luminous bands were the problem: their raw spot made the hero a neon field.
  it.each([
    ["SK Green", "#15a65a", "149 93% 28%"],
    ["Emerald", "#10b981", "160 99% 27%"],
    ["SK Gold", "#8a7436", "44 72% 34%"],
    ["CueIQ", "#4f46e5", "243 90% 60%"],
  ])("%s's dark spot is walked down to %s's table value", (_, hex, want) => {
    expect(spotFor(hex).dark).toBe(want);
  });

  it.each(BANDS)("%s: the skin's --spot is spotFor()'s, in both themes", (_, hex) => {
    const skin = parseSkin(skinCss(hex));
    expect(skin.light["--spot"]).toBe(spotFor(hex).light);
    expect(skin.dark["--spot"]).toBe(spotFor(hex).dark);
  });

  it("relativeLuminance() is WCAG's", () => {
    expect(relativeLuminance("0 0% 100%")).toBeCloseTo(1, 6);
    expect(relativeLuminance("0 0% 0%")).toBe(0);
    expect(relativeLuminance("0 100% 50%")).toBeCloseTo(0.2126, 4); // pure red
  });

  // The band that never picked a colour gets theme.css as-is, so theme.css owes it the
  // same on-primary promise skinCss() keeps for every other band. Dark used to put
  // navy text on the indigo fill (4.1:1): the header mark, the avatar letter and every
  // primary button on a fresh device.
  it.each(["light", "dark"] as const)("the default band (no skin), %s: on-primary text clears AA", (theme) => {
    const t = themeTokens[theme];
    expect(contrast(t["--primary-foreground"], t["--primary"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("skinCss() holds WCAG anywhere on the colour wheel", () => {
  const sweep: string[] = [];
  for (let h = 0; h < 360; h += 5) {
    for (const s of [35, 70, 100]) for (const l of [25, 45, 60, 75]) sweep.push(hslHex(h, s, l));
  }
  it(`${sweep.length} colours`, () => {
    expect(sweep.flatMap(failures)).toEqual([]);
  });
});

describe("what a skin may and may not touch", () => {
  it.each(BANDS)("%s: leaves only, and never the band-independent tokens", (_, hex) => {
    const css = skinCss(hex);
    expect(css).not.toContain("var(");
    // The Live warning ladder, the overtime plate and the unread dot look the same
    // for every band — by rule, so no skin may write them.
    expect(css).not.toMatch(/--(notify|alarm|warning|urgent-wash-a)[\w-]*:/);
    // The light's knobs are band-independent by rule (spec §C): every band throws the
    // same light, and export / print zero them in one place.
    expect(css).not.toMatch(/--(spot-a|spot-core-a|vig-a|glow-a|glass-a|lit-muted-foreground):/);
  });

  it("the guard's idea of the theme red is theme.css's", () => {
    expect([hueOf(themeDestructive.light), hueOf(themeDestructive.dark)]).toEqual([...THEME_DESTRUCTIVE_HUES]);
  });

  // The other half of that rule, from the screens' side: the delete-red guard above
  // moves --destructive for a red band, so a ladder step painted with bg-destructive
  // turned VIOLET on Seishin's devices (and Crimson's, Sunset's, Sakura's) while
  // every other band's stayed red. Each colour the WARN / URGENT / OVER steps use
  // must be a token no skin writes.
  //
  // Since the Live slice the steps are no longer a class map in each screen: they
  // are app/stage.css's zone classes, and the two screens only NAME them. So the
  // rule is held in two halves — the screens wear the steps through those classes
  // and paint no step colour of their own, and every colour those rules read is a
  // token no skin writes.
  const LADDERS = ["components/live/now-card.tsx", "desktop/src/pages/my-show.tsx"];
  it.each(LADDERS)("%s: wears WARN / URGENT / OVER through stage.css's zone classes", (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    // the card's zone expression: Quick Show's `zoneClasses`, the NOW card's className
    const zone =
      /const zoneClasses = cn\(([\s\S]*?)\);/.exec(src)?.[1] ??
      /data-zone=\{zone\}\s*className=\{cn\(([\s\S]*?)\)\}/.exec(src)?.[1];
    expect(zone, "the zone classes moved — point this test at their new home").toBeTruthy();
    for (const cls of ["zone-warn", "zone-urgent", "alarm-plate", "settled"]) {
      expect(zone, `no .${cls} step`).toMatch(new RegExp(`["\\s]${cls}["\\s]`));
    }
    // …and no step colour of its own: not the band, not the skin-moved red, not --notify
    expect(zone).not.toMatch(/(?<![\w-])(?:bg|text|border|ring)-(?:primary|destructive|notify)\b/);
    // The interim map and its dimming pulse are gone for good.
    expect(src).not.toMatch(/animate-pulse-ring|(?<![\w-])bg-notify\b/);
  });

  it("app/stage.css: every colour the WARN / URGENT / OVER rules read is a token no skin writes", () => {
    const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../app/stage.css"), "utf8"));
    const STEP = /\.(?:zone-warn|zone-urgent|zone-over|alarm-plate|hazard-band)\b/;
    const tokens = new Set<string>();
    let rules = 0;
    let settledFrame = "";
    css.walkRules((r) => {
      if (!STEP.test(r.selector)) return;
      rules += 1;
      // colours only: the timing tokens in animation / transition are not the point
      const values = r.nodes
        .flatMap((n) => (n.type === "decl" && !/^(animation|transition)/.test(n.prop) ? [n.value] : []))
        .join(";");
      // The settled plate is a CARD by design (ten seconds past zero the alarm stops
      // shouting): its fill follows the skin; what must not is its alarm frame.
      if (/^\.alarm-plate\.settled$/.test(r.selector.trim())) {
        settledFrame = values;
        return;
      }
      for (const m of values.matchAll(/var\(--([\w-]+)/g)) tokens.add(m[1]);
    });
    expect(rules, "the ladder rules moved out of app/stage.css").toBeGreaterThanOrEqual(8);
    expect(settledFrame, "the settled plate keeps its alarm frame").toContain("var(--alarm)");
    for (const step of ["warning", "warning-ink", "warning-foreground", "urgent-wash-a", "alarm", "alarm-foreground"]) {
      expect(tokens, `the ladder no longer reads --${step}`).toContain(step);
    }
    for (const token of tokens) {
      // a real theme token, not a typo or a raw palette name…
      expect(themeTokens.light, `--${token} is not a theme.css token`).toHaveProperty(`--${token}`);
      // …and not one any band colour rewrites
      for (const [name, hex] of BANDS) {
        expect(skinCss(hex), `${name} reskins --${token} under the Live ladder`).not.toContain(`--${token}:`);
      }
    }
  });
});

// The band that never picked a colour gets theme.css as-is, so theme.css owes it every
// promise skinCss() keeps for a band that did. Until v3 this block was a `.fails`
// KNOWN GAP: theme.css kept the pre-redesign surfaces (light --input 220 13% 91% was
// 1.24:1 on white — login, library search and the overview selects showed fields with
// no visible edge). The Stage Wash surfaces landed with the light, so it is the guard.
describe("theme.css's own tokens (no band skin)", () => {
  it.each(["light", "dark"] as const)("%s: --input clears 3:1 on card and page", (theme) => {
    const t = themeTokens[theme];
    expect(contrast(t["--input"], t["--card"])).toBeGreaterThanOrEqual(3);
    expect(contrast(t["--input"], t["--background"])).toBeGreaterThanOrEqual(3);
  });

  it.each(["light", "dark"] as const)("%s: band ink, and the text in the lit hero, clear AA on the lit surface", (theme) => {
    const t = themeTokens[theme];
    const lit = litSurface(theme, t);
    expect(contrast(t["--primary-ink"], lit)).toBeGreaterThanOrEqual(4.5);
    // .lit re-points --muted-foreground to this (stage.css): secondary text in the glow
    expect(contrast(t["--lit-muted-foreground"], lit)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["--lit-muted-foreground"], t["--card"])).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: the stage light obeys the ceiling every band's does", () => {
    expect(relativeLuminance(themeTokens.dark["--spot"])).toBeLessThanOrEqual(SPOT_LUM_MAX);
  });

  // The static defaults had drifted from the skin since v2 (spec §0.0, "Lead" graft):
  // a device with no colour and a device that picked the default indigo must paint
  // the same surfaces. Every neutral the skin writes, theme.css writes identically.
  it.each(["light", "dark"] as const)("%s: the surfaces and the light are exactly skinCss(\"#4f46e5\")'s", (theme) => {
    const skin = parseSkin(skinCss("#4f46e5"))[theme];
    const keys = ["--background", "--card", "--popover", "--secondary", "--muted", "--border", "--input", "--spot"];
    const want = Object.fromEntries(keys.map((k) => [k, skin[k]]));
    const got = Object.fromEntries(keys.map((k) => [k, themeTokens[theme][k]]));
    expect(got).toEqual(want);
  });
});
