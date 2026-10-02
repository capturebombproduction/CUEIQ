import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// THE PRE-PAINT SCRIPT IN desktop/index.html — where it sits decides who wins.
//
// The band colour a device saved is replayed before first paint by an inline script
// that appends <style id="cueiq-skin"> to <head>. Its rules (:root / .dark tokens)
// tie the app stylesheet's on specificity, so the LATER one in the document wins.
// Vite's build puts the app's <link rel="stylesheet"> at the END of <head>, AFTER
// every inline script the page already had — so a script in <head> appended the skin
// BEFORE the stylesheet and the saved colour lost on every restart (the picker then
// wrote into that same early element and a freshly picked colour did nothing either).
// The web does not have the problem: app/layout.tsx runs the same script at the top
// of <body>, after every head stylesheet.
//
// This executes the real file in a real parser (jsdom) with the stylesheet link
// placed where Vite puts it, rather than asserting on the markup's shape.
// ─────────────────────────────────────────────────────────────────────────────

// jsdom ships no types here, and this file is typechecked by desktop/tsconfig; a
// require() hands back `any`, which is all a harness needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: any };

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(join(desktopDir, "index.html"), "utf8");

/** What `vite build` does to the page: its module script + stylesheet go in at the end
 *  of <head> (checked against desktop/dist/index.html), after any inline script. */
const BUILT_HEAD_TAIL =
  '<script type="module" crossorigin src="./assets/index.js"></script>' +
  '<link rel="stylesheet" crossorigin href="./assets/index.css">';

function boot(storage: Record<string, string>) {
  const html = indexHtml.replace("</head>", `${BUILT_HEAD_TAIL}</head>`);
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    beforeParse(win: Window) {
      for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
    },
  });
  return dom.window.document as Document;
}

const SKIN = { hex: "#a62a1c", css: ":root{--primary:6 71% 38%}.dark{--primary:6 71% 46%}" };

describe("desktop/index.html — the pre-paint accent script", () => {
  it("lands the saved skin AFTER the app stylesheet, so the saved colour wins", () => {
    const doc = boot({ "cueiq:accent": JSON.stringify(SKIN) });
    const skin = doc.getElementById("cueiq-skin");
    const sheet = doc.querySelector('link[rel="stylesheet"]');
    expect(skin).not.toBeNull();
    expect(skin!.textContent).toBe(SKIN.css);
    expect(sheet).not.toBeNull();
    expect(sheet!.compareDocumentPosition(skin!) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
    expect(doc.head.lastElementChild).toBe(skin);
  });

  it("adds nothing on a device that never picked a colour", () => {
    const doc = boot({});
    expect(doc.getElementById("cueiq-skin")).toBeNull();
  });

  it("still flips to the light theme before paint when the user chose it", () => {
    expect(boot({ "cueiq:theme": "light" }).documentElement.classList.contains("dark")).toBe(false);
    expect(boot({}).documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps the root mount point the app renders into", () => {
    expect(boot({}).getElementById("root")).not.toBeNull();
  });
});
