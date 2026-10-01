import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type Root } from "postcss";
import tailwind from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import resolveConfig from "tailwindcss/resolveConfig";

// ─────────────────────────────────────────────────────────────────────────────
// ONE THEME, TWO APPS. The web app and the desktop renderer used to keep separate,
// hand-synced copies of the design tokens and the Tailwind theme; the desktop copy
// had already lost the print sheet by the time anyone looked. Now app/theme.css
// holds every token value and tailwind.preset.ts the theme, and both apps load
// them. These tests keep it that way — and pin the one ordering trap the move
// exposed: an @import can only sit ABOVE @tailwind base, preflight's own `*` rule
// sets border-color, so a `* { border-color }` moved into theme.css silently
// loses to gray-200 in every bordered box of both apps.
//
// Only root packages are used: the root CI job never installs desktop/.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, "..");
const THEME = path.join(repoRoot, "app/theme.css");
const SHEETS = {
  web: path.join(repoRoot, "app/globals.css"),
  desktop: path.join(repoRoot, "desktop/src/index.css"),
} as const;
const CONFIGS = {
  web: path.join(repoRoot, "tailwind.config.ts"),
  desktop: path.join(repoRoot, "desktop/tailwind.config.ts"),
} as const;

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
  it.each(Object.entries(SHEETS))("%s stylesheet imports theme.css above @tailwind", (_, file) => {
    const root = parseFile(file);
    const firstTailwind = root.nodes.findIndex(
      (n) => n.type === "atrule" && n.name === "tailwind"
    );
    const theme = localImports(root, file).find((i) => i.target === THEME);
    expect(theme, "no @import of app/theme.css").toBeDefined();
    expect(firstTailwind).toBeGreaterThan(theme!.at);
    // Being above @tailwind is not enough: ANY rule above it (say, desktop's
    // `:root { --font-kanit }` moved to the top) voids it the same way. Only what
    // CSS itself allows ahead of an @import may sit there.
    const ahead = root.nodes
      .slice(0, theme!.at)
      .filter(
        (n) =>
          n.type !== "comment" &&
          !(n.type === "atrule" && (n.name === "import" || n.name === "charset")) &&
          !(n.type === "atrule" && n.name === "layer" && !n.nodes)
      )
      .map((n) => `${n.toString().split("\n")[0]} (line ${n.source?.start?.line})`);
    expect(ahead, "rules above the theme @import void it").toEqual([]);
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
    expect(web.theme.colors).toHaveProperty("warning.DEFAULT", "hsl(var(--warning))");
  });
});

describe("the compiled CSS", () => {
  const CONTENT = [{ raw: '<div class="border border-border"></div>', extension: "html" }];
  const plugins = (which: keyof typeof CONFIGS) => [
    tailwind({ ...loadConfig(CONFIGS[which]), content: CONTENT }),
  ];

  /** Next: postcss-loader runs Tailwind on EACH file, then css-loader emits every
   *  @import'ed module ahead of its importer. (So theme.css must be plain CSS — an
   *  `@layer base` in it would throw here, as it would in `next build`.) */
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

  it.each([
    ["web", compileWeb],
    ["desktop", compileDesktop],
  ] as const)("%s: token border colour wins over preflight, and the print sheet ships", async (_, compile) => {
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
});
