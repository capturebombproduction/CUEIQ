// The fingerprints of UTF-8 that was decoded as a single-byte codepage and written
// back — split out from check-encoding.mjs so they can be TESTED.
//
// Windows PowerShell 5.1's `Get-Content | Set-Content` is the source: it reads a
// UTF-8-without-BOM file using the system ANSI codepage (cp1252 on this machine) and
// re-encodes the result. Thai lives in U+0E00–U+0E7F, whose UTF-8 lead byte is 0xE0
// — cp1252 renders that as "à" — so Thai mojibake is overwhelmingly "à¸" / "à¹".
//
// encoding-check: this file contains deliberate mojibake samples — a detector has to
// contain what it detects, and loosening the patterns until they stop matching their
// own examples would blind it to the real thing.
//
// ── WHY THIS IS NARROWER THAN IT COULD BE ────────────────────────────────────────
// The previous version derived its patterns from the UTF-8 byte shape in general:
// any LEAD byte (0xC2–0xF4) followed by the right number of CONTINUATION bytes
// (0x80–0xBF). That derivation is correct about UTF-8 and wrong about text, because
// cp1252 renders most lead bytes as ORDINARY LETTERS — É ß Ö × Ø à é æ ç ô ñ — and
// renders the continuation range as ORDINARY PUNCTUATION: NBSP, SHY, « », °, ±, ·,
// µ, ½, ¡, ¿. So "a letter next to a punctuation mark", which is what typeset prose
// is made of, matched. Of the 53 legitimate strings now pinned in the healthy corpus
// of lib/mojibake.test.ts, ELEVEN fired under that scheme; none fire under this one.
// Both of these are healthy text and both used to fail the gate:
//
//     1920<NBSP>×<NBSP>1080          ->  "×" + NBSP  is a lead + a continuation
//     «<NBSP>déjà<NBSP>» — c'est ça  ->  "à" + NBSP + "»"  is a lead + two
//
// A gate that reds CI on correctly-typeset French gets deleted, and then the real
// hazard — a Thai file round-tripped through PowerShell, which no other gate in this
// repo can see — goes unwatched. So the shape is inverted: every fingerprint now
// begins with an ANCHOR that cannot occur in human text (à¸ · â€ · Ã · Â · ðŸ),
// and the continuation class only ever appears AFTER that anchor, where its breadth
// is free. That buys a measured zero false positives, and it costs coverage, which
// is paid below in the open rather than hidden behind a wide pattern. The coverage
// that remains is still enough to catch the real thing whole: the three files this
// was checked against after an actual `Get-Content | Set-Content` round-trip lit up
// on 400, 76 and 26 separate lines.
//
// ── WHAT IS DETECTED ─────────────────────────────────────────────────────────────
//   Thai            every character of U+0E00–U+0E7F, which is the whole point
//   punctuation     all of U+2000–U+203F: — – “ ” ‘ ’ „ ‚ … • † ‡ ‰ ‹ ›, and the
//                   invisible ones (NNBSP, ZWSP) — every comment block here is
//                   full of these, so they are the clear second priority
//   Latin letters   all of U+00C0–U+00FF: é à ü ñ ç ß æ ø þ ð Ð Þ Æ Ø ÿ × ÷
//   Latin symbols   all of U+0080–U+00BF: NBSP SHY ¡ ¢ £ ¤ ¥ ¦ § ¨ © ª « ¬ ® ¯
//                   ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿
//   emoji           U+1F000–U+1FFFF, the pictograph planes: 🎤 🔴 🚦 — but NOT the
//                   older 3-byte symbols that read as emoji (✅ ⭐ ⚠), see below
//
// ── WHAT IS NOT DETECTED, DELIBERATELY ───────────────────────────────────────────
// Nothing below has a two-character anchor that is impossible in real prose, so
// covering it means matching "letter + punctuation" again. None of it is a language
// this repo is written in.
//
//   CJK, kana, Hangul and CJK punctuation   中 日本語 한국어 。「」、
//   Greek, Cyrillic, Hebrew, Arabic, Devanagari, Lao, Khmer
//   Latin Extended-A                        ł č ğ ā ő ş  (Polish/Czech/Turkish/Baltic)
//   Vietnamese's Latin Extended-B letters   ế đ ạ ọ  (its plain à é ô ARE covered)
//   arrows and symbol blocks                → ← ⇒ ✅ ✓ ★ ⭐ ⚠ ▪ ─
//   € and ™, and currency beyond Latin-1    ₫ ₩   (£ ¥ ¢ ¤ ARE covered)
//   superscripts U+2070+                    ⁰ ⁴   (¹ ² ³ ARE covered)
//   4-byte characters that are not emoji    CJK Ext-B, ancient scripts
//
// In practice a file that PowerShell has round-tripped is mangled in EVERY line that
// held a non-ASCII byte, and this repo's prose carries Thai and em dashes throughout,
// so a file whose only casualty is an arrow is close to hypothetical. The gate reports
// per line but fails per file; one caught line is enough.
//
// ── THE ONE IRREDUCIBLE FALSE POSITIVE ───────────────────────────────────────────
// "Ã—" is exactly how "×" mangles, and "Â»" is exactly how "»" mangles. A healthy
// file that contains those two characters adjacent is indistinguishable from a
// mangled one — not a defect in the pattern, an ambiguity in the data. Real text
// where Ã or Â is immediately followed by punctuation is rare enough that no string
// in the corpus hits it by accident; if one ever does, that file opts out with the
// marker rather than the pattern getting loosened for everybody.

// Bytes 0x80–0xBF as cp1252 renders them — the alphabet a mangled continuation byte
// is drawn from, and nothing else. Used only as the TAIL of a fingerprint:
//   0xA0–0xBF → U+00A0–U+00BF verbatim: NBSP ¡ ¢ £ ¤ ¥ ¦ § ¨ © ª « ¬ SHY ® ¯
//                              ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿
//   0x80–0x9F → the cp1252 "specials": € ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™
//                              š › œ ž Ÿ, plus five bytes (81 8D 8F 90 9D) cp1252
//                              does not map at all, which survive as bare C1 controls
//                              — 0x9D is exactly why an earlier hand-kept class
//                              silently missed `”`.
const CONT =
  "\\u0080-\\u00bf" + // C1 controls and Latin-1 punctuation (incl. NBSP and SHY)
  "\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192" + // Œ œ Š š Ÿ Ž ž ƒ
  "\\u02c6\\u02dc" + // ˆ ˜
  "\\u2013\\u2014\\u2018\\u2019\\u201a\\u201c\\u201d\\u201e" + // – — ‘ ’ ‚ “ ” „
  "\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203a" + // † ‡ • … ‰ ‹ ›
  "\\u20ac\\u2122"; // € ™

// Each entry spells out the WHOLE mangled character, not just its beginning: Thai is
// three bytes so it is three characters here, an emoji is four. That costs nothing in
// coverage — a real mangled character always has all of its bytes — and it removes
// the last theoretically-reachable false positive, a French footnote marker in "là¹".
//
// Order matters only for the reported sentence; the first match on a line wins.
export const FINGERPRINTS = [
  {
    // 0xE0 0xB8/0xB9 + 1: U+0E00–U+0E7F. Thai's first two bytes are always these.
    pattern: new RegExp(`à[¸¹][${CONT}]`),
    what: "Thai text re-encoded from a single-byte codepage",
  },
  {
    // 0xE2 0x80 + 1: U+2000–U+203F, the general-punctuation block.
    pattern: new RegExp(`â€[${CONT}]`),
    what: "punctuation (em dash / smart quote / ellipsis / bullet) re-encoded",
  },
  {
    // 0xC3 + 1: U+00C0–U+00FF, every accented Latin letter plus × and ÷.
    pattern: new RegExp(`Ã[${CONT}]`),
    what: "an accented Latin letter (é à ü ñ ç ß ø þ ×) re-encoded",
  },
  {
    // 0xC2 + 1: U+0080–U+00BF, the Latin-1 punctuation and symbols.
    pattern: new RegExp(`Â[${CONT}]`),
    what: "a Latin-1 symbol (NBSP · ° © ± « » µ ½ § ¿) re-encoded",
  },
  {
    // 0xF0 0x9F + 2: U+1F000–U+1FFFF, the emoji planes. "ð" + "Ÿ" is as impossible
    // in real text as "à¸" is, which is why this one survived the narrowing while
    // the general 4-byte pattern (ð–ô followed by any three) did not.
    pattern: new RegExp(`ðŸ[${CONT}][${CONT}]`),
    what: "an emoji re-encoded",
  },
];

/** U+FFFD means the bytes are not valid UTF-8 at all — a different, worse failure
 *  than a mis-transcode, and worth naming separately. */
export const REPLACEMENT_CHAR = "�";

/** Every suspicious line in `text`, 1-indexed. */
export function findMojibake(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(REPLACEMENT_CHAR)) {
      out.push({ line: i + 1, what: "not valid UTF-8 (contains U+FFFD)", text: line });
      continue;
    }
    for (const f of FINGERPRINTS) {
      if (f.pattern.test(line)) {
        out.push({ line: i + 1, what: f.what, text: line });
        break;
      }
    }
  }
  return out;
}
