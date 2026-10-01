import { afterEach, describe, expect, it } from "vitest";
import { ACCENT_STORAGE_KEY, SKIN_STYLE_ID, refreshSavedAccent, skinCss } from "@/lib/accent";

const stored = () => JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) || "null");

afterEach(() => {
  localStorage.clear();
  document.getElementById(SKIN_STYLE_ID)?.remove();
});

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
