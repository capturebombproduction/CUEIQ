import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The JPG export captures a node while <html> still carries `.dark`, so a `dark:`
// utility inside the captured subtree paints its DARK value onto the white picture:
// .export-light swaps the TOKENS, it cannot switch a `dark:` variant off. Print is the
// same story. So the files that render an exported / printed surface use tokens only
// (bg-warning/10, text-warning-ink …) — FINAL-SPEC-v2 §D.3.

const repoRoot = path.resolve(__dirname, "..");
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(path.join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
        ? [path.join(dir, e.name).replace(/\\/g, "/")]
        : []
  );

/** Every line with a `dark:` variant, as "file: line". */
const darkVariants = (files: string[]) =>
  files.flatMap((f) =>
    fs
      .readFileSync(path.join(repoRoot, f), "utf8")
      .split(/\r?\n/)
      .filter((line) => /(^|[\s"'`])dark:/.test(line))
      .map((line) => `${f}: ${line.trim()}`)
  );

describe("exported / printed surfaces use tokens, not dark: variants", () => {
  it("the run sheet (event-summary.tsx) has none", () => {
    expect(darkVariants(["components/event/event-summary.tsx"])).toEqual([]);
  });

  // The board's two amber badges, the last known exceptions, went with the Overview
  // restyle (§G.7): the whole folder is now held to none.
  it("the Overview export has none", () => {
    const files = filesUnder("components/overview");
    expect(files.length).toBeGreaterThan(0);
    expect(darkVariants(files)).toEqual([]);
  });
});
