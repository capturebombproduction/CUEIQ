import { afterEach, describe, expect, it } from "vitest";
import {
  ACCENT_STORAGE_KEY,
  SKIN_STYLE_ID,
  refreshSavedAccent,
  saveAccent,
  skinCss,
} from "@/lib/accent";

const stored = () => JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) || "null");

afterEach(() => {
  localStorage.clear();
  document.getElementById(SKIN_STYLE_ID)?.remove();
  document.head.querySelectorAll("link[rel=stylesheet]").forEach((l) => l.remove());
});

/** The app's own stylesheet — what Vite (desktop) / Next (web) put in <head>. */
const appStylesheet = () => {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/app.css";
  document.head.appendChild(l);
  return l;
};
const skinEl = () => document.getElementById(SKIN_STYLE_ID)!;

describe("refreshSavedAccent", () => {
  it("rewrites a skin saved under older tokens, so the device stops painting stale overrides", () => {
    localStorage.setItem(
      ACCENT_STORAGE_KEY,
      JSON.stringify({ hex: "#a62a1c", css: ":root{--primary:0 0% 0%}" })
    );
    expect(refreshSavedAccent()).toBe(true);
    expect(stored()).toEqual({ hex: "#a62a1c", css: skinCss("#a62a1c") });
    expect(document.getElementById(SKIN_STYLE_ID)?.textContent).toBe(skinCss("#a62a1c"));
  });

  it("leaves a current skin alone", () => {
    const css = skinCss("#2563eb");
    localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify({ hex: "#2563eb", css }));
    expect(refreshSavedAccent()).toBe(false);
    expect(document.getElementById(SKIN_STYLE_ID)).toBeNull();
  });

  it("does nothing on a device that never picked a colour", () => {
    expect(refreshSavedAccent()).toBe(false);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("survives a corrupt entry instead of throwing", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "{not json");
    expect(refreshSavedAccent()).toBe(false);
  });
});

// The skin's :root / .dark rules and the app stylesheet's tokens have EQUAL
// specificity, so whichever comes later in the document wins. The skin therefore has
// to be the LAST thing in <head> — and the desktop's pre-paint script used to put it
// BEFORE Vite's <link> (see desktop/src/index-html.test.ts), after which a colour
// picked later was written into that early element and still lost, every restart.
describe("where the skin <style> sits relative to the app stylesheet", () => {
  it("saveAccent re-seats a skin an early script left BEFORE the stylesheet, at the end of <head>", () => {
    const early = document.createElement("style");
    early.id = SKIN_STYLE_ID;
    early.textContent = ":root{--primary:0 0% 0%}";
    document.head.appendChild(early);
    const link = appStylesheet();
    expect(early.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    saveAccent("#a62a1c");

    expect(document.querySelectorAll(`#${SKIN_STYLE_ID}`)).toHaveLength(1);
    expect(skinEl()).toBe(early); // the same element: moved, not duplicated
    expect(document.head.lastElementChild).toBe(skinEl());
    expect(link.compareDocumentPosition(skinEl()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skinEl().textContent).toBe(skinCss("#a62a1c"));
  });

  it("refreshSavedAccent re-seats it the same way (it goes through saveAccent)", () => {
    localStorage.setItem(
      ACCENT_STORAGE_KEY,
      JSON.stringify({ hex: "#a62a1c", css: ":root{--primary:0 0% 0%}" })
    );
    const early = document.createElement("style");
    early.id = SKIN_STYLE_ID;
    document.head.appendChild(early);
    appStylesheet();

    expect(refreshSavedAccent()).toBe(true);
    expect(document.head.lastElementChild).toBe(skinEl());
  });

  // The web's behaviour, which must not change: layout.tsx's pre-paint script runs in
  // <body>, so its `document.head.appendChild` already lands the skin AFTER every
  // head stylesheet — and picking another colour keeps it there.
  it("web: a skin already last in <head> stays the one, last element and just takes the new rules", () => {
    appStylesheet();
    const early = document.createElement("style");
    early.id = SKIN_STYLE_ID;
    early.textContent = ":root{--primary:0 0% 0%}";
    document.head.appendChild(early);

    saveAccent("#2563eb");

    expect(document.querySelectorAll(`#${SKIN_STYLE_ID}`)).toHaveLength(1);
    expect(skinEl()).toBe(early);
    expect(document.head.lastElementChild).toBe(early);
    expect(early.textContent).toBe(skinCss("#2563eb"));
  });

  it("web: the first colour ever picked creates the element at the end of <head>", () => {
    appStylesheet();
    expect(document.getElementById(SKIN_STYLE_ID)).toBeNull();

    saveAccent("#10b981");

    expect(document.head.lastElementChild).toBe(skinEl());
    expect(skinEl().textContent).toBe(skinCss("#10b981"));
    expect(stored()).toEqual({ hex: "#10b981", css: skinCss("#10b981") });
  });

  it("a stylesheet that arrives AFTER the skin (a lazily-loaded route CSS) is out-ranked again by the next pick", () => {
    saveAccent("#10b981");
    const late = appStylesheet();
    expect(skinEl().compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    saveAccent("#2563eb");

    expect(document.head.lastElementChild).toBe(skinEl());
  });
});
