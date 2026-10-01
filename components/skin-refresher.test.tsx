// A band colour saved under older tokens is re-derived on every app load. It used
// to happen when AccentPicker mounted — and the redesign moved the colour swatches
// into the More sheet, whose contents exist only while it is open. Unmoved, a
// device would have kept painting a stale skin until somebody opened the sheet.
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ACCENT_STORAGE_KEY, SKIN_STYLE_ID, skinCss } from "@/lib/accent";
import { SkinRefresher } from "./skin-refresher";

afterEach(() => {
  document.getElementById(SKIN_STYLE_ID)?.remove();
});

describe("SkinRefresher", () => {
  it("re-derives a stale saved skin as soon as it mounts, and renders nothing", () => {
    localStorage.setItem(
      ACCENT_STORAGE_KEY,
      JSON.stringify({ hex: "#a62a1c", css: ":root{--primary:0 0% 0%}" })
    );
    const { container } = render(<SkinRefresher />);
    expect(container).toBeEmptyDOMElement();
    expect(JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY)!).css).toBe(skinCss("#a62a1c"));
    expect(document.getElementById(SKIN_STYLE_ID)?.textContent).toBe(skinCss("#a62a1c"));
  });
});
