// The page light's element (spec v3 §E.11). Its paint is pinned in
// lib/stage-wash.test.ts; what is pinned here is the element every mount point
// shares: decorative, out of print, and aimed only when asked.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { StageLight } from "@/components/stage-light";

const REPO = path.resolve(__dirname, "..");

describe("StageLight", () => {
  it("is one decorative, unprintable .spotlight layer with nothing inside it", () => {
    const { container } = render(<StageLight />);
    const el = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(el).toHaveClass("spotlight", "no-print");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.childNodes).toHaveLength(0);
    // Unaimed it writes no --spot-x of its own, so a responsive class (Live's
    // `stage:[--spot-x:27%]`) or an inherited value can still aim it — an inline 50%
    // would beat both.
    expect(el.style.getPropertyValue("--spot-x")).toBe("");
  });

  // FRAME_LIGHT_AIM keeps a centred-column page's light on its column — but only
  // for pages that SAY so. A new centred page that forgot the marker would get its
  // hot core off to the left of its title at lg, so every page root that is one
  // centred column (and stays one at lg) must carry it, web and desktop alike.
  // FRAME_LIGHT_AIM puts the top-left of a page in the hot core at lg. The one band-ink
  // text there — the practice room's 15 px "‹ TRAINING" — fell to 4.26:1 on Sakura
  // (light) and 3.98:1 on Crimson (dark, at the first aim tried), so the word is ink
  // and the band colour stays on the chevron, as `.lit .eyebrow` does in a glow.
  it("the practice room's way back is ink in the light, its chevron in the band", () => {
    for (const f of ["app/(app)/events/[id]/practice/page.tsx", "desktop/src/pages/practice.tsx"]) {
      const src = fs.readFileSync(path.join(REPO, f), "utf8");
      const link = /<Link\b[^>]*?className="([^"]*)"[^>]*>\s*<ChevronLeft className="([^"]*)"/.exec(src);
      expect(link, f).not.toBeNull();
      expect(link![1].split(/\s+/), f).toContain("text-foreground");
      expect(link![1], f).not.toMatch(/text-primary-ink/);
      expect(link![2].split(/\s+/), f).toContain("text-primary-ink");
    }
  });

  it("every centred-column page marks itself for the frame's aim", () => {
    const root = REPO;
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return walk(rel);
        return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [rel] : [];
      });
    const pages = [...walk("app/(app)").filter((f) => /page\.tsx$/.test(f)), ...walk("desktop/src/pages")];
    const centred: string[] = [];
    const unmarked: string[] = [];
    for (const f of pages) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      // the page's ROOT element: the first JSX tag after the component's `return (`
      for (const m of src.matchAll(/return \(\s*(?:\/\/[^\n]*\n\s*)*<div\b([^>]*)>/g)) {
        const cls = /className="([^"]*)"/.exec(m[1])?.[1] ?? "";
        if (!/(^|\s)mx-auto(\s|$)/.test(cls) || !/(^|\s)max-w-/.test(cls) || /(^|\s)lg:max-w-/.test(cls)) continue;
        centred.push(f);
        if (!/\bdata-stage-centred\b/.test(m[1])) unmarked.push(f);
      }
    }
    expect(centred.length, "found no centred page at all — the scan is broken").toBeGreaterThanOrEqual(6);
    expect(unmarked).toEqual([]);
  });

  it("aims the hot core where it is told", () => {
    const { container } = render(<StageLight x="27%" className="stage:[--spot-x:27%]" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.getPropertyValue("--spot-x")).toBe("27%");
    expect(el).toHaveClass("spotlight", "no-print", "stage:[--spot-x:27%]");
  });
});
