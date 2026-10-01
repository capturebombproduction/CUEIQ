import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What html-to-image saw on the node at the moment it took the picture.
const atCapture: { exportClass: boolean; inlineTokens: string[]; width: string }[] = [];
let captureThrows = false;

vi.mock("html-to-image", () => ({
  toJpeg: vi.fn(async (el: HTMLElement) => {
    atCapture.push({
      exportClass: el.classList.contains("export-light"),
      inlineTokens: Array.from(el.style).filter((p) => p.startsWith("--")),
      width: el.style.width,
    });
    if (captureThrows) throw new Error("canvas tainted");
    return "data:image/jpeg;base64,AAAA";
  }),
}));

import { captureElementToImage } from "@/lib/export-image";

// The JPG's light palette is app/theme.css `.export-light` (every token, knobs zeroed).
// It used to be a 19-token map set inline here, which every later token — warning,
// info, the inks, alarm — would have slipped past, painting its DARK value onto the
// white picture. lib/theme-single-source.test.ts holds the class's contents; this
// holds the helper to actually wearing it, and to taking it off again.
describe("captureElementToImage — light palette by class", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    atCapture.length = 0;
    captureThrows = false;
    el = document.createElement("div");
    el.style.width = "50%";
    document.body.appendChild(el);
    // jsdom cannot navigate a data: link; the download path's click is not under test.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it("wears .export-light while the picture is taken, and nothing inline", async () => {
    await expect(captureElementToImage(el, { filename: "x.jpg" })).resolves.toBe("downloaded");
    expect(atCapture).toEqual([{ exportClass: true, inlineTokens: [], width: "600px" }]);
  });

  it("takes the class off and restores the width afterwards", async () => {
    await captureElementToImage(el, { filename: "x.jpg" });
    expect(el.classList.contains("export-light")).toBe(false);
    expect(el.style.width).toBe("50%");
    expect(el.getAttribute("style")).not.toContain("--");
  });

  it("…even when the capture throws", async () => {
    captureThrows = true;
    await expect(captureElementToImage(el, { filename: "x.jpg" })).rejects.toThrow("canvas tainted");
    expect(atCapture[0].exportClass).toBe(true);
    expect(el.classList.contains("export-light")).toBe(false);
    expect(el.style.width).toBe("50%");
  });

  it("leaves a caller's own .export-light where it was", async () => {
    el.classList.add("export-light");
    await captureElementToImage(el, { filename: "x.jpg" });
    expect(el.classList.contains("export-light")).toBe(true);
  });
});
