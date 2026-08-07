import { describe, it, expect } from "vitest";
import { findMojibake } from "../scripts/mojibake.mjs";

// The encoding gate (scripts/check-encoding.mjs) is the only check in this repo whose
// subject is the BYTES rather than the syntax — it exists because round 10 nearly
// shipped mojibake into a live confirm dialog while tsc, lint and 394 tests stayed
// green. A detector that never fires would be worse than none: it would make the
// whole class look covered. So fire it here, on mojibake produced the same way the
// real thing is produced.
//
// encoding-check: this file contains deliberate mojibake samples (the U+FFFD literal
// below is one of the things being detected).

/** UTF-8 bytes decoded as Windows-1252 and kept as text — exactly what
 *  `Get-Content | Set-Content` does in Windows PowerShell 5.1. */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function mangle(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("latin1")
    .split("")
    .map((c) => {
      const b = c.charCodeAt(0);
      return String.fromCharCode(CP1252[b] ?? b);
    })
    .join("");
}

describe("mojibake detection", () => {
  it("catches Thai that went through a single-byte codepage", () => {
    const broken = mangle("บันทึกแล้ว");
    expect(broken).not.toContain("บ"); // sanity: the fixture really is mangled
    expect(findMojibake(broken)).toHaveLength(1);
  });

  it.each([
    "ยืนยันการลบ",
    "เกินเวลา",
    "โหมดซ้อม",
    "พร้อมโชว์ออฟไลน์",
    "ไม่พบหน้านี้",
  ])("catches the real UI string %s", (thai) => {
    expect(findMojibake(mangle(thai))).toHaveLength(1);
  });

  it("catches a mangled em dash even in an otherwise ASCII line", () => {
    // The comment blocks in this repo are full of em dashes, so this is the shape
    // that would corrupt a file whose Thai content happened to be untouched.
    expect(findMojibake(mangle("the show — it must go on"))).toHaveLength(1);
  });

  it("catches accented Latin", () => {
    expect(findMojibake(mangle("café"))).toHaveLength(1);
  });

  it("catches bytes that are not valid UTF-8 at all", () => {
    expect(findMojibake("broken � here")[0].what).toMatch(/not valid UTF-8/);
  });

  it("reports the 1-indexed line", () => {
    const text = ["fine", "also fine", mangle("เสียง")].join("\n");
    expect(findMojibake(text)).toHaveLength(1);
    expect(findMojibake(text)[0].line).toBe(3);
  });

  it("leaves healthy files alone", () => {
    // Everything here is legitimate content from this codebase. A gate that cries
    // wolf on real Thai, real em dashes or real code is a gate someone will delete.
    const healthy = [
      "ยืนยันการลบ — พิมพ์ชื่อเพื่อยืนยัน",
      "เสียงออกเครื่องเดียว",
      "// A write that reported no error but touched no row did not happen.",
      "const x = { a: 1 }; // café, naïve, Zoë",
      "à la carte", // a real French phrase: "à" followed by a space, not a Thai byte
      "Ça va",
      "โหมดซ้อม · Practice Mode · 中文 · 日本語",
    ].join("\n");
    expect(findMojibake(healthy)).toEqual([]);
  });
});
