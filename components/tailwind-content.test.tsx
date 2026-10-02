import path from "node:path";
import postcss from "postcss";
import tailwind from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { describe, expect, it } from "vitest";

// Round 15. Tailwind reads every string in a scanned file as a class candidate, so the
// fixtures and assertions inside a TEST (a class name quoted in an expect) were emitted
// into the shipped stylesheet as real rules: .line-clamp-none out of live-mode.test.tsx,
// .ring-ring out of stage-css.test.tsx, ten more, in the web CSS and the desktop's.
// Both configs now negate `*.test.*` in their content globs.
//
// This file is the probe. It lives in components/, which BOTH configs scan, and it
// quotes one arbitrary-property class nothing else in the repo uses. If the negation is
// ever dropped, that class appears in the compiled CSS and the first test fails.

const PROBE = "[--tw-r15-content-probe:1]";
const PROBE_RULE = ".\\[--tw-r15-content-probe\\:1\\]";

const repoRoot = path.resolve(__dirname, "..");
const CONFIGS = {
  web: path.join(repoRoot, "tailwind.config.ts"),
  desktop: path.join(repoRoot, "desktop/tailwind.config.ts"),
} as const;

/** The config's own content globs, made absolute: Tailwind resolves a relative glob
 *  against the cwd, and the two apps are built from different directories. Negations
 *  (`!glob`) are kept or dropped as asked, so the same list can be compiled with and
 *  without them. */
function contentGlobs(configFile: string, keepNegations: boolean): string[] {
  const dir = configFile.split(path.sep).slice(0, -1).join("/");
  const config = loadConfig(configFile);
  const files = (Array.isArray(config.content) ? config.content : config.content.files) as unknown[];
  return files
    .filter((g): g is string => typeof g === "string")
    .filter((g) => keepNegations || !g.startsWith("!"))
    .map((g) => (g.startsWith("!") ? `!${path.posix.join(dir, g.slice(1))}` : path.posix.join(dir, g)));
}

async function compile(configFile: string, keepNegations: boolean): Promise<string> {
  const config = loadConfig(configFile);
  const out = await postcss([
    tailwind({ ...config, content: contentGlobs(configFile, keepNegations) }),
  ]).process("@tailwind utilities;", { from: undefined });
  return out.css;
}

describe.each(Object.entries(CONFIGS))("%s tailwind config", (_name, file) => {
  it("does not turn a class quoted in a test file into a rule", async () => {
    // control: with the negations dropped the probe in THIS file is scanned and emitted,
    // so the check below cannot pass just because the probe went undetected
    expect(await compile(file, false), `${PROBE} was not found even without the negations`).toContain(PROBE_RULE);

    expect(await compile(file, true), `${PROBE} came from a test file`).not.toContain(PROBE_RULE);
  });

  it("negates test files and nothing else", () => {
    const negated = contentGlobs(file, true).filter((g) => g.startsWith("!"));
    expect(negated.length).toBeGreaterThan(0);
    for (const g of negated) expect(g).toMatch(/\.test\.\{[a-z,]+\}$/);
  });
});

describe("what real source still emits", () => {
  it("the web CSS keeps a class from app/ and one from components/", async () => {
    const css = await compile(CONFIGS.web, true);
    expect(css).toContain(".antialiased"); // app/layout.tsx
    expect(css).toContain(".sticky"); // components/ui/table.tsx
  });

  it("the desktop CSS keeps a class that only desktop/src uses", async () => {
    // desktop/src/components/shell.tsx — and shell.test.tsx quotes it too, so this also
    // shows the source file is read while its test is not the reason it is there
    const css = await compile(CONFIGS.desktop, true);
    expect(css).toContain(".\\[scrollbar-width\\:none\\]");
  });
});
