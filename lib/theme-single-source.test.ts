import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type Root, type Rule } from "postcss";
import tailwind from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import resolveConfig from "tailwindcss/resolveConfig";
import { ACCENT_PRESETS } from "@/lib/accent";
import { skinCss } from "@/lib/skin";

// ─────────────────────────────────────────────────────────────────────────────
// ONE THEME, TWO APPS. The web app and the desktop renderer used to keep separate,
// hand-synced copies of the design tokens and the Tailwind theme; the desktop copy
// had already lost the print sheet by the time anyone looked. Now app/theme.css
// holds every token value, app/stage.css every component class and
// tailwind.preset.ts the theme, and both apps load them. These tests keep it that
// way — and pin the ordering traps the move exposed: an @import can only sit ABOVE
// @tailwind base, preflight's own `*` rule sets border-color, so a `* { border-color }`
// moved into theme.css silently loses to gray-200 in every bordered box of both apps;
// and the same position puts stage.css above preflight AND the utilities.
//
// Only root packages are used: the root CI job never installs desktop/.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, "..");
const THEME = path.join(repoRoot, "app/theme.css");
const STAGE = path.join(repoRoot, "app/stage.css");
const SHEETS = {
  web: path.join(repoRoot, "app/globals.css"),
  desktop: path.join(repoRoot, "desktop/src/index.css"),
} as const;
const CONFIGS = {
  web: path.join(repoRoot, "tailwind.config.ts"),
  desktop: path.join(repoRoot, "desktop/tailwind.config.ts"),
} as const;
const PREFLIGHT = path.join(repoRoot, "node_modules/tailwindcss/lib/css/preflight.css");

const parseFile = (file: string) => postcss.parse(fs.readFileSync(file, "utf8"), { from: file });

/** Local `@import "./x.css"` targets of a sheet, resolved; package imports skipped. */
function localImports(root: Root, file: string): { at: number; target: string }[] {
  const out: { at: number; target: string }[] = [];
  root.each((node, at) => {
    if (node.type !== "atrule" || node.name !== "import") return;
    const spec = node.params.replace(/^["']|["']$/g, "");
    if (spec.startsWith(".")) out.push({ at, target: path.resolve(path.dirname(file), spec) });
  });
  return out;
}

/** Custom-property declarations of one rule, in source order. */
const declsOf = (rule: Rule) => {
  const out: Record<string, string> = {};
  rule.each((n) => {
    if (n.type === "decl" && n.prop.startsWith("--")) out[n.prop] = n.value;
  });
  return out;
};

type Spec = [number, number, number];
const cmpSpec = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const addSpec = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Split on commas that are not inside parentheses. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  return [...out, cur.trim()].filter(Boolean);
}

/** CSS specificity of ONE selector — enough of the algorithm for these sheets:
 *  :is / :not / :has count their most specific argument, :where counts nothing. */
function specificity(selector: string): Spec {
  let total: Spec = [0, 0, 0];
  let rest = "";
  for (let i = 0; i < selector.length; i++) {
    const m = /^:(is|not|where|has)\(/.exec(selector.slice(i));
    if (!m) {
      rest += selector[i];
      continue;
    }
    let depth = 1;
    let j = i + m[0].length;
    for (; j < selector.length && depth > 0; j++) {
      if (selector[j] === "(") depth++;
      if (selector[j] === ")") depth--;
    }
    const args = splitTopLevel(selector.slice(i + m[0].length, j - 1)).map(specificity);
    if (m[1] !== "where") total = addSpec(total, args.reduce((a, b) => (cmpSpec(a, b) >= 0 ? a : b)));
    i = j - 1;
  }
  const take = (re: RegExp) => {
    const n = (rest.match(re) ?? []).length;
    rest = rest.replace(re, " ");
    return n;
  };
  const attrs = take(/\[[^\]]*\]/g); // first: an attribute value may hold a "." or ":"
  const pseudoEls = take(/::[\w-]+(\([^)]*\))?/g);
  const ids = take(/#[\w-]+/g);
  const classes = take(/\.[\w-]+/g);
  const pseudoClasses = take(/:[\w-]+(\([^)]*\))?/g);
  const types = (rest.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return addSpec(total, [ids, attrs + classes + pseudoClasses, types + pseudoEls]);
}

/** Type name of a selector's subject (its last compound), or null for `*` / none. */
const subjectType = (selector: string) =>
  /^[a-zA-Z][\w-]*/.exec(selector.trim().split(/[\s>+~]+/).at(-1) ?? "")?.[0] ?? null;

describe("design tokens have one home", () => {
  const tokens = new Set<string>();
  parseFile(THEME).walkDecls((d) => {
    if (d.prop.startsWith("--")) tokens.add(d.prop);
  });

  it("theme.css actually defines the palette (or the checks below prove nothing)", () => {
    for (const t of ["--background", "--foreground", "--primary", "--border", "--radius"]) {
      expect(tokens).toContain(t);
    }
  });

  it.each(Object.entries(SHEETS))("%s stylesheet gives no token a value of its own", (_, file) => {
    const redefined: string[] = [];
    parseFile(file).walkDecls((d) => {
      if (tokens.has(d.prop)) redefined.push(`${d.prop} (line ${d.source?.start?.line})`);
    });
    expect(redefined).toEqual([]);
  });

  // An @import below another rule is not an error anywhere: Vite's postcss-import
  // only warns and leaves it, and the browser then drops it — an .exe with no
  // colours at all, from a build that "succeeded".
  it.each(Object.entries(SHEETS))(
    "%s stylesheet imports theme.css, then stage.css, above @tailwind",
    (_, file) => {
      const root = parseFile(file);
      const firstTailwind = root.nodes.findIndex(
        (n) => n.type === "atrule" && n.name === "tailwind"
      );
      const imports = localImports(root, file);
      const theme = imports.find((i) => i.target === THEME);
      const stage = imports.find((i) => i.target === STAGE);
      expect(theme, "no @import of app/theme.css").toBeDefined();
      expect(stage, "no @import of app/stage.css — the component classes never ship").toBeDefined();
      // Tokens first, so a reader of stage.css finds them defined above it.
      expect(stage!.at).toBeGreaterThan(theme!.at);
      expect(firstTailwind).toBeGreaterThan(stage!.at);
      // Being above @tailwind is not enough: ANY rule above it (say, desktop's
      // `:root { --font-kanit }` moved to the top) voids it the same way. Only what
      // CSS itself allows ahead of an @import may sit there.
      const ahead = root.nodes
        .slice(0, stage!.at)
        .filter(
          (n) =>
            n.type !== "comment" &&
            !(n.type === "atrule" && (n.name === "import" || n.name === "charset")) &&
            !(n.type === "atrule" && n.name === "layer" && !n.nodes)
        )
        .map((n) => `${n.toString().split("\n")[0]} (line ${n.source?.start?.line})`);
      expect(ahead, "rules above the theme/stage @imports void them").toEqual([]);
    }
  );
});

// The JPG export (lib/export-image.ts puts .export-light on the captured node) and the
// paper run sheet each swap the WHOLE palette by redeclaring the token names. Any token
// they miss keeps its screen value — under html.dark, a dark one, on a white picture.
describe("export and print palettes (theme.css)", () => {
  const theme = parseFile(THEME);
  const topRule = (selector: string) => {
    const hits: Rule[] = [];
    theme.each((n) => {
      if (n.type === "rule" && n.selector === selector && Object.keys(declsOf(n)).length) hits.push(n);
    });
    expect(hits, `exactly one token rule ${selector}`).toHaveLength(1);
    return hits[0];
  };
  const light = declsOf(topRule(":root"));
  const dark = declsOf(topRule(".dark"));
  const exportLight = declsOf(topRule(".export-light"));
  const printRules: Rule[] = [];
  theme.walkAtRules("media", (m) => {
    if (m.params !== "print") return;
    m.each((n) => {
      if (n.type === "rule" && Object.keys(declsOf(n)).length) printRules.push(n);
    });
  });

  it("declares every token whose value differs between light and dark", () => {
    const themed = Object.keys(dark).filter((k) => light[k] !== dark[k]);
    expect(themed.length).toBeGreaterThan(20); // or the check below proves nothing
    expect(themed.filter((k) => !(k in exportLight))).toEqual([]);
  });

  it("declares every token a band skin writes (a dark skin sits on <html> too)", () => {
    const written = new Set<string>();
    for (const { hex } of ACCENT_PRESETS) {
      for (const m of skinCss(hex).matchAll(/(--[\w-]+):/g)) written.add(m[1]);
    }
    expect(written).toContain("--destructive"); // Seishin's hue guard, or this is too weak
    expect([...written].filter((k) => !(k in exportLight))).toEqual([]);
  });

  it("carries the v2 + v3 tokens and zeroes every light / glow knob", () => {
    for (const t of [
      "--notify", "--notify-foreground", "--alarm", "--alarm-foreground", "--info-ink",
      "--warning-ink", "--success-ink", "--primary-ink", "--faint-foreground",
      // v3 (spec §D.6): they differ between :root and .dark, so a capture under
      // html.dark would otherwise inherit the dark value
      "--spot", "--shadow", "--lit-muted-foreground",
    ]) {
      expect(exportLight, t).toHaveProperty(t);
    }
    // The stage wash's four knobs (page light: long throw, hot core, vignette; the
    // lit hero's glow) plus v2's: a JPG and a sheet of paper are flat.
    const KNOBS = ["--shadow-a", "--spot-a", "--spot-core-a", "--vig-a", "--glow-a", "--edge-a", "--urgent-wash-a", "--scrim-a"];
    for (const knob of KNOBS) {
      expect(exportLight[knob], knob).toBe("0");
      // …and each is a real screen knob, not one export zeroes and nothing reads
      expect(light, knob).toHaveProperty(knob);
      expect(dark, knob).toHaveProperty(knob);
    }
    expect(exportLight["--glass-a"]).toBe("1"); // a solid bar, not a frosted one
  });

  // v2's light was replaced, not added to (spec §A.1): its knobs must not linger as
  // dead tokens a later rule could pick up again.
  it("v2's cone / halftone knobs are gone from every palette and from stage.css", () => {
    const stageCss = fs.readFileSync(STAGE, "utf8");
    for (const gone of ["--cone-core-a", "--tex-a", "--beam-k", "--cone-x"]) {
      for (const [where, d] of Object.entries({ light, dark, exportLight })) {
        expect(d, `${where} ${gone}`).not.toHaveProperty(gone);
      }
      expect(stageCss, `stage.css ${gone}`).not.toContain(gone);
    }
  });

  // Every knob is 0 on paper anyway, so a forgotten layer would still paint nothing;
  // the light layer and the sweep are not painted at all (spec §D.5).
  it("print hides the page light and the sweep", () => {
    let hidden: string[] = [];
    theme.walkAtRules("media", (m) => {
      if (m.params !== "print") return;
      m.walkRules((r) => {
        if (r.nodes.some((n) => n.type === "decl" && n.prop === "display" && /none/.test(n.value) && n.important)) {
          hidden = hidden.concat(r.selectors);
        }
      });
    });
    expect(hidden).toEqual(expect.arrayContaining([".spotlight", ".lit.sweep::after"]));
    expect(hidden.filter((s) => /\.cone\b|::before/.test(s))).toEqual([]);
  });

  it("print declares exactly the export palette", () => {
    expect(printRules).toHaveLength(1);
    expect(declsOf(printRules[0])).toEqual(exportLight);
  });

  // A band skin is a <style> injected after this sheet with :root{…} .dark{…}. At
  // equal specificity it won, and a skinned dark-mode run sheet printed dark cards.
  it("print out-ranks a band skin's :root / .dark", () => {
    for (const sel of printRules[0].selectors) {
      expect(cmpSpec(specificity(sel), [0, 1, 0]), sel).toBeGreaterThan(0);
    }
  });

  // Leaves only: the export / print swap redeclares a NAME, and an alias would keep
  // reading the screen value it points at. The font stacks are the one exception.
  it("token values are leaves (no var()), except the font stacks", () => {
    const aliased: string[] = [];
    for (const [where, d] of Object.entries({ light, dark, exportLight, print: declsOf(printRules[0]) })) {
      for (const [k, v] of Object.entries(d)) {
        if (v.includes("var(") && !k.startsWith("--font-")) aliased.push(`${where} ${k}: ${v}`);
      }
    }
    expect(aliased).toEqual([]);
  });
});

// The fonts are named in three places that never import each other: next/font on
// web, @fontsource + :root on desktop, and the stacks in theme.css. A name that
// drifts does not fail anything — it silently renders every numeral in Kanit.
describe("Barlow Condensed reaches both apps under the names theme.css reads", () => {
  const themeCss = fs.readFileSync(THEME, "utf8");
  const layout = fs.readFileSync(path.join(repoRoot, "app/layout.tsx"), "utf8");
  const desktopCss = fs.readFileSync(SHEETS.desktop, "utf8");

  it.each(["--font-barlow", "--font-barlow-x"])("%s: read by theme.css, set by both apps", (v) => {
    expect(themeCss).toContain(`var(${v},`);
    expect(layout).toContain(`variable: "${v}"`);
    expect(declsOf(parseFile(SHEETS.desktop).nodes.find(
      (n): n is Rule => n.type === "rule" && n.selector === ":root" && v in declsOf(n as Rule)
    )!)[v]).toBe('"Barlow Condensed"');
  });

  it("web ships 700 + 800 upright and ONLY 800 italic (two loaders, both on <html>)", () => {
    expect(layout).toMatch(/weight: \["700", "800"\],\s*style: \["normal"\]/);
    expect(layout).toMatch(/weight: "800",\s*style: "italic"/);
    expect(layout).not.toMatch(/style: \[[^\]]*italic/); // would also ship a 700 italic
    expect(layout).toMatch(/className=\{`[^`]*\$\{barlow\.variable\}[^`]*\$\{barlowX\.variable\}/);
  });

  it("desktop bundles the same three faces (no network font, ever)", () => {
    const faces = [...desktopCss.matchAll(/@import "@fontsource\/barlow-condensed\/([\w-]+)\.css"/g)].map((m) => m[1]);
    expect(faces).toEqual(["700", "800", "800-italic"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop/package.json"), "utf8"));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).toHaveProperty("@fontsource/barlow-condensed");
  });
});

// stage.css is PLAIN CSS imported above @tailwind base (its header says why). That
// is only safe while every rule in it out-ranks preflight on specificity — it loses
// every tie, being earlier — and while nothing in it needs Tailwind to process it.
describe("stage.css stays plain CSS that out-ranks preflight", () => {
  const stage = parseFile(STAGE);

  it("uses nothing that needs Tailwind (web compiles this file on its own)", () => {
    const found: string[] = [];
    stage.walkAtRules((a) => {
      if (["layer", "apply", "tailwind", "screen", "config"].includes(a.name)) found.push(`@${a.name}`);
    });
    stage.walkDecls((d) => {
      if (/\b(theme|screen)\(/.test(d.value)) found.push(`${d.prop}: ${d.value}`);
    });
    expect(found).toEqual([]);
  });

  it("every rule beats preflight's element selectors", () => {
    const preflight: string[] = [];
    parseFile(PREFLIGHT).walkRules((r) => void preflight.push(...r.selectors));
    const losers: string[] = [];
    let checked = 0;
    stage.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as { name: string }).name)) return;
      // The reduced-motion kill switch: every declaration !important, so order and
      // specificity are moot by design.
      const decls = rule.nodes.filter((n) => n.type === "decl");
      if (decls.length && decls.every((d) => d.type === "decl" && d.important)) return;
      for (const sel of rule.selectors) {
        checked++;
        const spec = specificity(sel);
        if (spec[0] + spec[1] > 0) continue; // a class / attr / pseudo-class out-ranks any element selector
        // Element-only (`html kbd`): must beat every preflight rule aimed at the same
        // element type, or at every element (`*`). Preflight's few class-level rules
        // ([hidden], :disabled, [role=button], [type=search], :-moz-focusring,
        // :-moz-ui-invalid) win ties against ANY rule here, which is fine for what they
        // set (display / cursor / outline / appearance) — see stage.css's header.
        const type = subjectType(sel);
        const rivals = preflight.filter((p) => p.trim() === "*" || subjectType(p) === type);
        const beaten = rivals.filter((p) => cmpSpec(specificity(p), spec) >= 0);
        if (beaten.length) losers.push(`${sel} loses to preflight ${beaten.join(" | ")}`);
      }
    });
    expect(checked).toBeGreaterThan(100); // the walk really saw the sheet
    expect(losers).toEqual([]);
  });

  it("specificity helper agrees with the spec on the shapes used here", () => {
    expect(specificity(".alarm-plate:not(.settled)")).toEqual([0, 2, 0]);
    expect(specificity(".export-light :is(.h1, .h2, .title-slab)")).toEqual([0, 2, 0]);
    expect(specificity('[hidden]:where(:not([hidden="until-found"]))')).toEqual([0, 1, 0]);
    expect(specificity("input[type=range]::-webkit-slider-thumb")).toEqual([0, 1, 2]);
    expect(specificity("html kbd")).toEqual([0, 0, 2]);
    expect(specificity("*::before")).toEqual([0, 0, 1]);
  });
});

describe("one Tailwind theme", () => {
  it("web and desktop configs resolve to the same theme, dark mode and plugins", () => {
    const web = resolveConfig(loadConfig(CONFIGS.web));
    const desktop = resolveConfig(loadConfig(CONFIGS.desktop));
    expect(desktop.theme).toEqual(web.theme);
    expect(desktop.darkMode).toEqual(web.darkMode);
    expect(desktop.plugins?.length).toBe(web.plugins?.length);
    // …and that theme is the custom one, not two identical defaults.
    expect(web.theme.colors).toHaveProperty("warning.DEFAULT", "hsl(var(--warning) / <alpha-value>)");
    expect(web.theme.colors).toHaveProperty("warning.ink", "hsl(var(--warning-ink) / <alpha-value>)");
  });

  // The raw `stage` screen (see the preset) switches Tailwind's min-* / max-* variants
  // off: `max-sm:hidden` compiles to NOTHING, so the element just stays visible. Make
  // that loud here instead of on a phone at a venue.
  it("no source writes a min-* / max-* screen variant (this config drops them)", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(rel);
        return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const hits = ["components", "app", "lib", "desktop/src"].flatMap(walk).flatMap((f) =>
      fs
        .readFileSync(path.join(repoRoot, f), "utf8")
        .split(/\r?\n/)
        .flatMap((line, i) =>
          /(^|[\s"'`])(min|max)-(sm|md|lg|xl|2xl|\[[^\]\s]+\]):[\w[-]/.test(line) ? [`${f}:${i + 1}`] : []
        )
    );
    expect(hits, "use the mobile-first form (`hidden sm:block`) instead").toEqual([]);
  });
});

/** Every `animate-*` utility the app's source names (variant prefixes stripped by the
 *  look-behind). An animation that the preset lost compiles to NOTHING — no warning,
 *  no error, and a component test that checks the class name stays green. That is
 *  how OVER lost its pulse while live-mode.test still passed. */
const ANIMATE_CLASSES = (() => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(rel);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
    });
  const found = new Set<string>();
  for (const f of ["components", "app", "lib", "desktop/src"].flatMap(walk)) {
    for (const m of fs.readFileSync(path.join(repoRoot, f), "utf8").matchAll(/(?<![\w-])animate-[a-z][\w-]*/g)) {
      found.add(m[0]);
    }
  }
  return [...found].sort();
})();

describe("the compiled CSS", () => {
  const CONTENT = [
    {
      raw: '<div class="border border-border chip h-11 animate-sheet-in bg-warning/10 text-warning-ink lg:h-9 stage:h-12"></div>',
      extension: "html",
    },
    { raw: `<div class="${ANIMATE_CLASSES.join(" ")}"></div>`, extension: "html" },
  ];
  const plugins = (which: keyof typeof CONFIGS) => [
    tailwind({ ...loadConfig(CONFIGS[which]), content: CONTENT }),
  ];

  /** Next: postcss-loader runs Tailwind on EACH file, then css-loader emits every
   *  @import'ed module ahead of its importer. (So theme.css and stage.css must be plain
   *  CSS — an `@layer` in either would throw here, as it would in `next build`.) */
  async function compileWeb(): Promise<Root> {
    const file = SHEETS.web;
    const main = (await postcss(plugins("web")).process(fs.readFileSync(file, "utf8"), { from: file })).root;
    const out = postcss.root();
    for (const { target } of localImports(main, file)) {
      const css = fs.readFileSync(target, "utf8");
      out.append((await postcss(plugins("web")).process(css, { from: target })).root.nodes);
    }
    main.walkAtRules("import", (a) => {
      if (a.params.replace(/^["']|["']$/g, "").startsWith(".")) a.remove();
    });
    return out.append(main.nodes);
  }

  /** Vite: postcss-import inlines @imports in place FIRST, then Tailwind runs once. */
  async function compileDesktop(): Promise<Root> {
    const file = SHEETS.desktop;
    const root = parseFile(file);
    for (const { at, target } of localImports(root, file).reverse()) {
      root.nodes[at].replaceWith(parseFile(target).nodes);
    }
    return (await postcss(plugins("desktop")).process(root, { from: file })).root;
  }

  const builds = [
    ["web", compileWeb],
    ["desktop", compileDesktop],
  ] as const;

  it.each(builds)("%s: token border colour wins over preflight, and the print sheet ships", async (_, compile) => {
    const root = await compile();
    // Same specificity, so the LAST top-level `*` rule setting border-color decides
    // every border that names no colour.
    const starBorders: string[] = [];
    root.each((n) => {
      if (n.type === "rule" && n.selectors.includes("*")) {
        n.walkDecls("border-color", (d) => {
          starBorders.push(d.value);
        });
      }
    });
    expect(starBorders.at(-1)).toBe("hsl(var(--border))");

    let printHidesControls = false;
    root.walkAtRules("media", (m) => {
      if (m.params === "print") m.walkRules(".no-print", () => void (printHidesControls = true));
    });
    expect(printHidesControls).toBe(true);

    let tokensShip = false;
    root.walkRules(":root", (r) => r.walkDecls("--border", () => void (tokensShip = true)));
    expect(tokensShip).toBe(true);
  });

  // The cascade a components layer would give: a utility on the same element beats a
  // component class (same specificity, later). `chip h-11` must be 44px, not 24px.
  it.each(builds)("%s: component classes ship, and a utility overrides them", async (_, compile) => {
    const root = await compile();
    const isRule = (selector: string) => (n: Root["nodes"][number]) => n.type === "rule" && n.selector === selector;
    const lastChip = root.nodes.findLastIndex(isRule(".chip"));
    const utility = root.nodes.findIndex(isRule(".h-11"));
    expect(lastChip, ".chip never shipped").toBeGreaterThanOrEqual(0);
    expect(utility, ".h-11 never generated").toBeGreaterThanOrEqual(0);
    expect(utility, "a .chip rule lands after the utilities and beats them").toBeGreaterThan(lastChip);
    // A keyframe the preset's animation names, defined only in stage.css.
    let sheetIn = false;
    root.walkAtRules("keyframes", (k) => void (k.params === "sheet-in" && (sheetIn = true)));
    expect(sheetIn).toBe(true);
    let animates = "";
    root.walkRules(".animate-sheet-in", (r) => r.walkDecls("animation", (d) => void (animates = d.value)));
    expect(animates).toMatch(/^sheet-in /);
    // <alpha-value> colours take an opacity modifier, and the ink tones exist.
    let tint = "";
    root.walkRules(".bg-warning\\/10", (r) => r.walkDecls("background-color", (d) => void (tint = d.value)));
    expect(tint).toBe("hsl(var(--warning) / 0.1)");
    let ink = false;
    root.walkRules(".text-warning-ink", () => void (ink = true));
    expect(ink).toBe(true);
  });

  it.each(builds)("%s: every animate-* class the app writes ships, keyframes included", async (_, compile) => {
    const root = await compile();
    expect(ANIMATE_CLASSES, "the source scan found nothing — it proves nothing").toContain("animate-spin");
    const keyframes = new Set<string>();
    root.walkAtRules(/keyframes$/, (k) => void keyframes.add(k.params));
    const broken = ANIMATE_CLASSES.filter((cls) => {
      let name: string | null = null;
      root.walkRules(`.${cls}`, (r) =>
        r.walkDecls(/^animation(-name)?$/, (d) => void (name = d.value.trim().split(/\s+/)[0]))
      );
      if (name === "none") return false;
      return name === null || !keyframes.has(name);
    });
    expect(broken, "compiles to nothing, or names keyframes no sheet defines").toEqual([]);
  });

  // A landscape iPad matches lg AND stage; the Live stage layout has to win there.
  it.each(builds)("%s: stage: is emitted after lg:, so it wins where both match", async (_, compile) => {
    const root = await compile();
    const at = (escaped: string) =>
      root.nodes.findIndex(
        (n) => n.type === "atrule" && !!n.nodes?.some((r) => r.type === "rule" && r.selector === escaped)
      );
    const lg = at(".lg\\:h-9");
    const stage = at(".stage\\:h-12");
    expect(lg).toBeGreaterThanOrEqual(0);
    expect(stage).toBeGreaterThan(lg);
    expect((root.nodes[stage] as { params: string }).params).toContain("orientation: landscape");
  });

  it("both apps get stage.css byte-for-byte, in the same order", async () => {
    const stageSelectors = (root: Root) => {
      const own = new Set<string>();
      parseFile(STAGE).walkRules((r) => void own.add(r.selector));
      const seen: string[] = [];
      root.walkRules((r) => {
        if (own.has(r.selector)) seen.push(`${r.selector}{${r.nodes.map(String).join(";")}}`);
      });
      return seen;
    };
    const web = stageSelectors(await compileWeb());
    expect(web.length).toBeGreaterThan(100);
    expect(stageSelectors(await compileDesktop())).toEqual(web);
  });
});
