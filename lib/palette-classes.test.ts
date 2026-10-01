import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec §G.4 / §J step 2: colour comes from tokens (bg-warning/10, text-success-ink,
// chip-*), never from Tailwind's raw palette. A raw `text-amber-600` skips the band
// skin, the light/dark pair, the export palette and the AA checks lib/skin.ts runs —
// and amber vs Seishin red is exactly the confusion the Live ladder must never make.
//
// The redesign is sweeping the existing ones out file by file, so this is a RATCHET:
// each file may hold at most what it held when the test landed (2026-10-01), and any
// other file none. A count may only go down — lower the budget when it does (to 0:
// delete the line). Member colours are data (members.color, inline style), not
// classes, so nothing here needs an exemption for them.
// A variant prefix (dark:, hover:, md:) ends in ":", which the look-behind allows.
// EVERY Tailwind colour family, not only the ones in use when this landed: the first
// list stopped at blue, so `bg-orange-500 text-white` (2.8:1 on the "ด่วน!" deadline
// chip) and the show-caller's violet kind chips walked straight past it.
const RAW_PALETTE =
  /(?<![\w-])(?:bg|text|border)-(?:red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|slate|gray|zinc|neutral|stone)-\d/g;

const BUDGET: Record<string, number> = {
  "components/practice/practice-journal.tsx": 12,
  "components/event/device-storage.tsx": 6,
  "components/song/song-library.tsx": 4,
  "components/practice/practice-player.tsx": 3,
  "components/practice/metronome.tsx": 2,
};

const repoRoot = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

function rawPaletteCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of sources("components")) {
    const n = (fs.readFileSync(path.join(repoRoot, f), "utf8").match(RAW_PALETTE) ?? []).length;
    if (n > 0) out[f] = n;
  }
  return out;
}

describe("raw Tailwind palette classes in components/", () => {
  it("the matcher sees prefixed and opacity forms, and not token names", () => {
    const hits = (s: string) => (s.match(RAW_PALETTE) ?? []).length;
    expect(hits('className="dark:text-amber-400 bg-amber-500/10 hover:border-rose-400"')).toBe(3);
    expect(hits('className="bg-warning/10 text-success-ink border-destructive chip-warning"')).toBe(0);
    expect(hits('className="text-redish-500 my-bg-blue-5"')).toBe(0);
    expect(hits('className="bg-orange-500 text-violet-600 dark:border-zinc-700"')).toBe(3);
  });

  it("no file holds more than it did when the sweep started (and new files hold none)", () => {
    const over = Object.entries(rawPaletteCounts())
      .filter(([f, n]) => n > (BUDGET[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} raw palette class(es), budget ${BUDGET[f] ?? 0} — use a token (bg-warning/10, text-success-ink, chip-*)`);
    expect(over).toEqual([]);
  });
});
