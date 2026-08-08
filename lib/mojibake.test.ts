import { describe, it, expect } from "vitest";
import { findMojibake } from "../scripts/mojibake.mjs";

// The encoding gate (scripts/check-encoding.mjs) is the only check in this repo whose
// subject is the BYTES rather than the syntax — it exists because round 10 nearly
// shipped mojibake into a live confirm dialog while tsc, lint and 394 tests stayed
// green. A detector that never fires would be worse than none: it would make the
// whole class look covered. So fire it here, on mojibake produced the same way the
// real thing is produced.
//
// This file has TWO halves and they pull against each other on purpose:
//   - "catches …" pins the coverage the detector claims, one case per family.
//   - "leaves healthy files alone" pins the false-positive rate at zero against a
//     corpus of legitimate content, and is the standing guard against the next
//     well-meaning widening. Wave 3 widened the patterns to the general UTF-8 byte
//     shape; 15 of these 66 strings failed the gate as a result, including a plain
//     dimensions line and correctly-typeset French. Anything that makes the healthy
//     list go red is a regression even if every "catches" test still passes.
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

/** Invisible spaces, built from their code points rather than typed: the whole hazard
 *  with these is that neither the healthy nor the mangled form shows up in a diff,
 *  and a fixture nobody can see is a fixture nobody can check. */
const NBSP = String.fromCharCode(0xa0); // U+00A0, the one French typography uses
const SHY = String.fromCharCode(0xad); // U+00AD soft hyphen, in German compounds
const NNBSP = String.fromCharCode(0x202f); // U+202F narrow no-break space

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

  // The whole U+2000–U+203F block, one character at a time. Two of these were missed
  // by a hand-kept class two rounds ago — `”` mangles through byte 0x9D, which cp1252
  // does not map at all, and `•` through 0xA2 — and a comment announcing coverage the
  // code does not have is this project's signature defect.
  it.each(["—", "–", "“", "”", "‘", "’", "„", "‚", "…", "•", "†", "‡", "‰", "‹", "›"])(
    "catches a lone mangled %s",
    (ch) => {
      expect(findMojibake(mangle(`a ${ch} b`))).toHaveLength(1);
    }
  );

  it("catches the invisible members of the punctuation block", () => {
    expect(findMojibake(mangle(`a${NNBSP}b`))).toHaveLength(1);
  });

  // The "Â…" family: U+0080–U+00BF, whose UTF-8 lead byte is 0xC2. `·` is a separator
  // this repo uses in real UI strings, and NBSP/SHY are invisible in every diff.
  it.each(["·", "°", "©", "®", "±", "«", "»", "µ", "½", "§", "¡", "¿", "£", "¥", "¹"])(
    "catches a lone mangled Latin-1 symbol %s",
    (ch) => {
      expect(findMojibake(mangle(`a${ch}b`))).toHaveLength(1);
    }
  );

  it.each([NBSP, SHY])("catches a mangled invisible Latin-1 space", (ch) => {
    expect(findMojibake(mangle(`a${ch}b`))).toHaveLength(1);
  });

  // The "Ã…" family: U+00C0–U+00FF, lead byte 0xC3 — every accented Latin letter.
  it.each(["café", "naïve", "Straße", "señor", "Þór", "Ærø", "1920×1080", "6÷2"])(
    "catches accented Latin in %s",
    (s) => {
      expect(findMojibake(mangle(s))).toHaveLength(1);
    }
  );

  it("catches a mangled 4-byte emoji", () => {
    expect(findMojibake(mangle("ready 🎤"))).toHaveLength(1);
    expect(findMojibake(mangle("status 🔴"))).toHaveLength(1);
  });

  it("catches bytes that are not valid UTF-8 at all", () => {
    expect(findMojibake("broken � here")[0].what).toMatch(/not valid UTF-8/);
  });

  it("reports the 1-indexed line", () => {
    const text = ["fine", "also fine", mangle("เสียง")].join("\n");
    expect(findMojibake(text)).toHaveLength(1);
    expect(findMojibake(text)[0].line).toBe(3);
  });

  // Coverage the detector gave up in wave 4 to stop crying wolf. These are pinned as
  // NOT detected so that the comment in scripts/mojibake.mjs cannot quietly become a
  // lie in either direction: if someone widens the patterns to catch them again, this
  // test fails and sends them back to the "NOT detected" list to update it — and to
  // the healthy corpus below to prove the widening was free.
  //
  // Each fixture had to be scrubbed of Latin-1 to stay in this list, which is the
  // gap's real size: "łódź" IS caught, because of the ó. A line has to be purely one
  // of these scripts to slip through, and a file has to be purely such lines to pass.
  it.each([
    ["CJK with no Latin-1 anywhere on the line", "「精神革命」、これは日本語です。"],
    ["an arrow alone", "offline → online"],
    ["a 3-byte symbol that reads as an emoji", "ready ✅"],
    ["Latin Extended-A (Polish/Czech/Turkish)", "łąka, čeština, doğru"],
    ["the euro sign alone", "10 € only"],
  ])("does NOT claim to catch %s", (_label, s) => {
    expect(findMojibake(mangle(s))).toEqual([]);
  });

  it("leaves healthy files alone", () => {
    // Everything here is legitimate content: real Thai UI strings from this codebase,
    // real code from it, and correctly-typeset prose in the languages a detector
    // built around cp1252 is most likely to trip over. A gate that reds CI on any of
    // it is a gate someone deletes, and then the real hazard goes unwatched — so this
    // list is the budget the fingerprints have to live inside, not a nice-to-have.
    const healthy = [
      // --- this repo's own Thai ---
      "ยืนยันการลบ — พิมพ์ชื่อเพื่อยืนยัน",
      "เสียงออกเครื่องเดียว",
      "โหมดซ้อม · Practice Mode",
      "พร้อมโชว์ออฟไลน์ · เกินเวลา ±1 นาที",
      "ไม่พบหน้านี้",
      `ตั้งเวลา 5${NBSP}นาที · ระยะ 3${NBSP}เมตร`,
      "offline → online → ✅ พร้อมโชว์ 🎤",
      "ราคา 100 € · 50 £ · 20 ¥ · ½ ชั่วโมง · หมายเหตุ¹",
      `ยืนยัน${NBSP}«${NBSP}ลบ${NBSP}»`,

      // --- French, including the typography that used to fail the gate. A NBSP
      //     between an accented word and its closing guillemet is an accented letter
      //     followed by two characters from the continuation alphabet; a wave-3
      //     pattern read that as a mangled 3-byte character. ---
      "Crème brûlée, à la carte, Ça va, naïve, Noël",
      "« Où ça ? » — déjà vu",
      `«${NBSP}déjà${NBSP}» — c'est ça`,
      `déjà${NBSP}»`,
      `l'été${NBSP}»`,
      `café${NBSP}…`,
      `là${NBSP}»`,
      `Le café${NBSP}: c'est prêt${NBSP}!`,
      `Le café${NNBSP}: c'est prêt${NNBSP}!`,
      `CAFÉ${NBSP}: ouvert`,
      "«ÉTÉ»",
      "là¹ voir note", // a footnote marker straight after "là"

      // --- German, Icelandic, Spanish, Portuguese, Vietnamese ---
      "Straße, Größe, Übung — schön, weiß, Fuß",
      "„Das war groß“ sagte er",
      "Größe—Gewicht—Preis",
      `Donau${SHY}dampf${SHY}schiff${SHY}fahrt`,
      `Größe: 5${NBSP}kg, Preis 10${NBSP}€`,
      "MÜNCHEN—BERLIN, GRÖSSE…",
      "Þórður á Ísafirði — þetta er ágætt",
      "Ærø, Þór, æðislegt, Halldór Laxness",
      "ÞÓRÐUR·ÍSAFJÖRÐUR",
      "¿Qué tal? ¡Muy bien! — señor Muñoz, Ñandú",
      "ESPAÑA·MADRID",
      "Tiếng Việt rất đẹp — Nguyễn Văn Ước",
      "Hà Nội · Thành phố Hồ Chí Minh",

      // --- units, dimensions, currency, legal marks: the reviewer's plain
      //     dimensions line is the first of these ---
      `1920${NBSP}×${NBSP}1080`,
      "1920 × 1080 px",
      "3×½ cup, 2×90°",
      `25${NBSP}°C ± 1${NBSP}°C`,
      "~5 µs · 3 Ω · 50 % · ½ · ¼ · ¾ · 2³ · m²",
      "€10 · £20 · ¥300 · ¢50 · ₩1000 · ฿500",
      "© 2026 A Lot Of Tone · ® · ™ · § 3 · ¶ 2 · ¡Olé!",

      // --- CJK and emoji: dropped from coverage, so they must not fire either ---
      "精神革命 · Seishin Kakumei · A Lot Of Tone",
      "中文 · 日本語 · 한국어",
      "「精神革命」、これは日本語です。",
      "ready ✅ 🎤 🚦 ⭐ 🔴 — 🇹🇭",

      // --- real code and comments out of this repo ---
      "// A write that reported no error but touched no row did not happen.",
      "const x = { a: 1 }; // café, naïve, Zoë",
      'throw new Error("ไม่พบเพลง — song_id ไม่ตรง");',
      "// “smart quotes” and ‘single’ ones — plus an ellipsis…",
      "const dash = '–'; // en dash, not a hyphen",
      '<div className="flex">{"→"}</div> // arrow in JSX',
      "// 0xA0–0xBF → U+00A0–U+00BF verbatim: NBSP ¡ ¢ £ ¤ ¥ ¦ § ¨ © ª « ¬",
      "// ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿ — the whole block, as a comment",
    ].join("\n");
    expect(findMojibake(healthy)).toEqual([]);
  });
});
