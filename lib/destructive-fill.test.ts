import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec §E.2: a SOLID red Button is the moment of no return — the action inside the
// confirm sheet (components/ui/confirm-dialog.tsx). Everywhere else a delete is the
// dashed `destructive-outline` with a trash icon, which opens that sheet. A page
// full of red fills teaches the eye to ignore red, and red is also the overtime /
// error language.
//
// A ratchet like lib/palette-classes.test.ts: the two call sites that predate the
// rule may keep theirs until their slice restyles them (lower the budget then);
// nothing else gains one. Badges are not counted — a destructive Badge is a tinted
// chip, not a fill.
const ALLOWED = new Set(["components/ui/confirm-dialog.tsx", "components/event/delete-event-button.tsx"]);
const BUDGET: Record<string, number> = {
  "components/song/song-library.tsx": 1,
};

const repoRoot = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.name === "node_modules") return [];
    if (e.isDirectory()) return sources(rel);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [rel] : [];
  });
}

/** `<Button … variant="destructive" …>` opening tags (an arrow `=>` in a prop is not the tag's end). */
function solidDestructiveButtons(src: string): number {
  const tags = src.match(/<Button\b(?:=>|[^>])*>/g) ?? [];
  return tags.filter((t) => /\bvariant=(?:"destructive"|\{\s*"destructive"\s*\})/.test(t)).length;
}

describe("solid destructive Buttons", () => {
  it("the matcher finds the solid fill across lines and past arrow props, and not the outline", () => {
    expect(solidDestructiveButtons('<Button\n  onClick={() => go()}\n  variant="destructive"\n>ลบ</Button>')).toBe(1);
    expect(solidDestructiveButtons('<Button variant="destructive-outline">ลบงาน</Button>')).toBe(0);
    expect(solidDestructiveButtons('<Badge variant="destructive">x</Badge>')).toBe(0);
  });

  it("appear only inside the confirm sheet (plus the call sites that predate the rule)", () => {
    const over = ["components", "app", "desktop/src"]
      .flatMap(sources)
      .filter((f) => !ALLOWED.has(f))
      .map((f) => [f, solidDestructiveButtons(fs.readFileSync(path.join(repoRoot, f), "utf8"))] as const)
      .filter(([f, n]) => n > (BUDGET[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} solid destructive Button(s) — use variant="destructive-outline" and confirm`);
    expect(over).toEqual([]);
  });
});
