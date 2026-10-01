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
  // every other band's stayed red. Each colour the WARN / URGENT / OVER steps name
  // must be a token no skin writes.
  const LADDERS = ["components/event/live-mode.tsx", "desktop/src/pages/my-show.tsx"];
  it.each(LADDERS)("%s: the WARN / URGENT / OVER colours are tokens no skin writes", (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const map = /const zoneClasses = \{([\s\S]*?)\}\[zone\]/.exec(src)?.[1];
    expect(map, "the zone class map moved — point this test at its new home").toBeTruthy();
    const tokens = new Set<string>();
    for (const step of ["warn", "urgent", "over"]) {
      const classes = new RegExp(`\\b${step}:\\s*"([^"]*)"`).exec(map!)?.[1];
      expect(classes, `no ${step} entry`).toBeTruthy();
      for (const m of classes!.matchAll(/(?<![\w-])(?:bg|text|border|ring)-([a-z]+(?:-[a-z]+)*)/g)) {
        tokens.add(m[1]);
      }
    }
    expect(tokens.size).toBeGreaterThan(0);
    for (const token of tokens) {
      // a real theme token, not a typo or a raw palette name…
      expect(themeTokens.light, `--${token} is not a theme.css token`).toHaveProperty(`--${token}`);
      // …and not one any band colour rewrites
      for (const [name, hex] of BANDS) {
        expect(skinCss(hex), `${name} reskins --${token} under ${file}'s ladder`).not.toContain(`--${token}:`);
      }
    }
  });
});
