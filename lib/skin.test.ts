import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { ACCENT_PRESETS } from "@/lib/accent";
import { THEME_DESTRUCTIVE_HUES, contrast, hexToHsl, skinCss } from "@/lib/skin";

// A band colour lands under or around text in five places: the primary fill (buttons,
// solid chips, the title slab), the band colour AS text (--primary-ink), the field
// boundary (--input), and the delete red next to it (--destructive). Each is walked
// to a WCAG ratio by lib/skin.ts; these hold every preset, both themes, to it — and a
// sweep of the whole colour wheel, because a band can pick ANY colour.

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

const hueOf = (triplet: string) => parseFloat(triplet);
const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

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
    need(`${theme} input on card`, contrast(t["--input"], t["--card"]), 3);
    need(`${theme} input on page`, contrast(t["--input"], t["--background"]), 3);
    // A grey band has no hue for the delete red to be confused with.
    if (s >= 15) {
      const destructive = t["--destructive"] ?? themeDestructive[theme];
      const dist = hueDist(hueOf(destructive), hexToHsl(hex).h);
      if (dist < 45) bad.push(`${hex} ${theme} destructive ${destructive} only ${dist}° from the band`);
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

  it("a blue band keeps the theme's own red", () => {
    expect(skinCss("#2563eb")).not.toContain("--destructive");
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

// The band that never picked a colour gets theme.css's own --input, and §J wants a
// field boundary of 3:1 on every surface it sits on (WCAG 1.4.11). theme.css still
// carries the PRE-redesign surface values on purpose (see its header): light
// --input 220 13% 91% is 1.24:1 on white — login, library search and the overview
// selects showed fields with no visible edge — and dark 217 33% 22% is 1.5:1. The
// final values (spec §A: light L54 / --border L80) land WITH the surface/lighting
// decision, because their hue follows it. Until then these two are marked `fails`, so
// they pass while the gap stands. When the new surfaces land and a theme clears 3:1,
// its line goes red ("expected to fail"): drop that `.fails` and it becomes the guard.
describe("theme.css's own field boundary (no band skin)", () => {
  it.fails.each(["light", "dark"] as const)(
    "KNOWN GAP until the surface tokens land, %s: --input clears 3:1 on card and page",
    (theme) => {
      const t = themeTokens[theme];
      expect(contrast(t["--input"], t["--card"])).toBeGreaterThanOrEqual(3);
      expect(contrast(t["--input"], t["--background"])).toBeGreaterThanOrEqual(3);
    }
  );
});
