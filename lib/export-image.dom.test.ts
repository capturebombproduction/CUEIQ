import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What html-to-image saw on the node at the moment it took the picture.
const atCapture: { exportClass: boolean; inlineTokens: string[]; width: string }[] = [];
let captureThrows = false;
// The options html-to-image was called with, one entry per capture.
const optionsSeen: { style?: Partial<CSSStyleDeclaration> }[] = [];

vi.mock("html-to-image", () => ({
  toJpeg: vi.fn(async (el: HTMLElement, options: { style?: Partial<CSSStyleDeclaration> }) => {
    optionsSeen.push(options);
    atCapture.push({
      exportClass: el.classList.contains("export-light"),
      inlineTokens: Array.from(el.style).filter((p) => p.startsWith("--")),
      width: el.style.width,
    });
    if (captureThrows) throw new Error("canvas tainted");
    return "data:image/jpeg;base64,AAAA";
  }),
}));

import { captureElementToImage, safeFileStem } from "@/lib/export-image";

// The JPG's light palette is app/theme.css `.export-light` (every token, knobs zeroed).
// It used to be a 19-token map set inline here, which every later token — warning,
// info, the inks, alarm — would have slipped past, painting its DARK value onto the
// white picture. lib/theme-single-source.test.ts holds the class's contents; this
// holds the helper to actually wearing it, and to taking it off again.
describe("captureElementToImage — light palette by class", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    atCapture.length = 0;
    optionsSeen.length = 0;
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

  // 2026-10-02 (CQ-24): html-to-image sizes its canvas from the node's clientHeight
  // but copies the node's COMPUTED margin onto the clone it draws. The summary sits
  // under a `space-y-4` wrapper (margin-top 16 px), so every JPG began with a 16 px
  // white strip and lost the card's bottom border and its last 16 px of padding.
  // `style` is applied to the clone's root only. jsdom cannot lay anything out, so
  // what is pinned is the option; the picture is measured in a browser (the first
  // non-white row of the JPG must be y = 0).
  it("draws the node without its own margin: style.margin = 0 for the cloned root", async () => {
    el.style.marginTop = "16px";
    await captureElementToImage(el, { filename: "x.jpg" });
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0].style).toEqual({ margin: "0" });
    // the live node keeps its margin — only the clone is reset
    expect(el.style.marginTop).toBe("16px");
  });
});

// 2026-10-02 (CQ-25): the three exporters named their file with
// `name.replace(/[^\w\-]+/g, "_") || fallback`. \w is ASCII-only, so "ปฏิวัติหัวใจ"
// became "_" — truthy, so the fallback never fired and every Thai show saved as
// "_.jpg" (or "_report.jpg", "_runorder.jpg").
describe("safeFileStem — a Thai show keeps its name", () => {
  it("keeps Thai letters, tone marks and vowels (combining marks included)", () => {
    expect(safeFileStem("ปฏิวัติหัวใจ", "summary")).toBe("ปฏิวัติหัวใจ");
  });

  it("turns each run of anything else into one underscore, keeping digits and both scripts", () => {
    expect(safeFileStem("SK Fan Meeting — ครบรอบ 2 ปี", "summary")).toBe("SK_Fan_Meeting_ครบรอบ_2_ปี");
    expect(safeFileStem("a/b:c", "summary")).toBe("a_b_c");
    expect(safeFileStem("a  --  b", "summary")).toBe("a_--_b");
  });

  it("trims the ends, and a name with nothing in it falls back", () => {
    expect(safeFileStem("  /A Lot Of Tone/ ", "run-order")).toBe("A_Lot_Of_Tone");
    expect(safeFileStem("///", "summary")).toBe("summary");
    expect(safeFileStem("", "summary")).toBe("summary");
    expect(safeFileStem("🎤🎤", "summary")).toBe("summary");
  });
});
