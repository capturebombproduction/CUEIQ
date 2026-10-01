import { createElement, Fragment } from "react";
import { describe, expect, it } from "vitest";
import { hasThai, THAI_RE } from "./thai";

describe("THAI_RE", () => {
  it("matches consonants, vowels, tone marks and Thai digits — and nothing Latin", () => {
    for (const s of ["ก", "ไ", "่", "๙", "ฮ"]) expect(THAI_RE.test(s), s).toBe(true);
    for (const s of ["A", "9", "—", "é", "日"]) expect(THAI_RE.test(s), s).toBe(false);
  });
});

describe("hasThai", () => {
  it("reads plain strings", () => {
    expect(hasThai("ลบเพลงนี้?")).toBe(true);
    expect(hasThai("Delete event?")).toBe(false);
  });

  it("finds Thai behind an icon and nested inside elements and fragments", () => {
    const icon = createElement("svg", { "aria-hidden": true });
    expect(hasThai([icon, " ", "สำรองข้อมูล (Backup → R2)"])).toBe(true);
    expect(hasThai(createElement("span", null, createElement("b", null, "ไมค์")))).toBe(true);
    expect(hasThai(createElement(Fragment, null, "Mic Map ", createElement("span", null, "(ไมค์)")))).toBe(true);
  });

  it("is false for English with icons, numbers, null and booleans", () => {
    const icon = createElement("svg", null);
    expect(hasThai([icon, "Setlist", 16, null, false, undefined])).toBe(false);
  });

  it("ignores text an element renders from other props (not written into the title)", () => {
    expect(hasThai(createElement("img", { alt: "รูป" }))).toBe(false);
  });
});
