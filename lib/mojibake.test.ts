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

/** A non-breaking space, built from its code point rather than typed: the whole
 *  hazard with this character is that neither its healthy nor its mangled form is
 *  visible in a diff, and a fixture nobody can see is a fixture nobody can check. */
const NBSP = String.fromCharCode(0xa0);

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

  // Every character the old punctuation fingerprint CLAIMED, one at a time, because
  // the claim was false for two of them: `”` mangles through byte 0x9D, which cp1252
  // does not map at all, and `•` through 0xA2, and neither was in the class. A
  // comment announcing coverage the code does not have is round 10's signature
  // defect, and a line whose only non-ASCII character is one of those two is a line
  // this gate used to wave through.
  it.each(["—", "–", "“", "”", "‘", "’", "…", "•", "†", "‰"])(
    "catches a lone mangled %s",
    (ch) => {
      expect(findMojibake(mangle(`a ${ch} b`))).toHaveLength(1);
    }
  );

  // The "Â…" family: characters whose UTF-8 lead byte is 0xC2. Not one of these was
  // detectable before — and `·` is a separator this repo uses in real UI strings.
  it.each(["·", "°", "©", "±", "«", "»"])("catches a lone mangled 2-byte %s", (ch) => {
    expect(findMojibake(mangle(`a${ch}b`))).toHaveLength(1);
  });

  it("catches a mangled non-breaking space", () => {
    expect(findMojibake(mangle(`a${NBSP}b`))).toHaveLength(1);
  });

  it("catches an arrow and CJK, which nothing matched before", () => {
    expect(findMojibake(mangle("offline → online"))).toHaveLength(1);
    expect(findMojibake(mangle("中文"))).toHaveLength(1);
    expect(findMojibake(mangle("日本語"))).toHaveLength(1);
    expect(findMojibake(mangle("精神革命"))).toHaveLength(1);
  });

  it("catches a mangled emoji", () => {
    expect(findMojibake(mangle("ready ✅"))).toHaveLength(1); // 3-byte
    expect(findMojibake(mangle("ready 🎤"))).toHaveLength(1); // 4-byte, lead 0xF0
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
    // wolf on real Thai, real em dashes or real code is a gate someone will delete,
    // so widening the fingerprints is only defensible while this list grows with
    // them: every family the detector newly matches appears here in its HEALTHY
    // form, and the risky shape — an accented letter immediately followed by a
    // symbol that is also a continuation byte — is pinned down deliberately.
    const healthy = [
      "ยืนยันการลบ — พิมพ์ชื่อเพื่อยืนยัน",
      "เสียงออกเครื่องเดียว",
      "// A write that reported no error but touched no row did not happen.",
      "const x = { a: 1 }; // café, naïve, Zoë",
      "à la carte", // a real French phrase: "à" followed by a space, not a Thai byte
      "Ça va",
      "โหมดซ้อม · Practice Mode · 中文 · 日本語",
      "Crème brûlée — 25° C, ±1°, © 2026, 1920×1080, ~5 µs",
      "« Où ça ? » — déjà, Æon, Þór, Straße, Ærø",
      "offline → online → ✅ พร้อมโชว์ 🎤",
      "精神革命 · Seishin Kakumei · A Lot Of Tone",
      "ราคา 100 € · 50 £ · 20 ¥ · ½ ชั่วโมง · หมายเหตุ¹",
      // Correct French typography: a NBSP between the accented word and its
      // punctuation, i.e. a continuation-byte glyph sitting immediately after a
      // 3-byte lead glyph. One is not two, so this must not fire.
      `Le café${NBSP}: c'est prêt${NBSP}!`,
    ].join("\n");
    expect(findMojibake(healthy)).toEqual([]);
  });
});
