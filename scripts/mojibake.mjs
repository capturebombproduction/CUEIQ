// The fingerprints of UTF-8 that was decoded as a single-byte codepage and written
// back — split out from check-encoding.mjs so they can be TESTED. A detector nobody
// ever fired is round 10's most common defect shape: a guard that ships as a no-op
// while its own comments announce success.
//
// Windows PowerShell 5.1's `Get-Content | Set-Content` is the source: it reads a
// UTF-8-without-BOM file using the system ANSI codepage (cp1252 on this machine) and
// re-encodes the result. Thai lives in U+0E00–U+0E7F, whose UTF-8 lead byte is 0xE0
// — cp1252 renders that as "à" — so Thai mojibake is overwhelmingly "à¸" / "à¹".
//
// The detection is derived from that mechanism rather than from a list of characters
// somebody remembered, because a hand-kept list is how round 10's version came to
// claim in its own comment that it covered `— – “ ” ‘ ’ … •` while measurably missing
// `”` and `•`. Every multi-byte UTF-8 character is one LEAD byte (0xC2–0xF4) followed
// by one to three CONTINUATION bytes (0x80–0xBF); match that shape once and every
// character in every script is covered at the same time.
//
// encoding-check: this file contains deliberate mojibake samples — a detector has to
// contain what it detects, and loosening the patterns until they stop matching their
// own examples would blind it to the real thing.

// Bytes 0x80–0xBF as cp1252 renders them — the alphabet a mangled continuation byte
// is drawn from, and nothing else:
//   0xA0–0xBF → U+00A0–U+00BF verbatim: NBSP ¡ ¢ £ ¤ ¥ ¦ § ¨ © ª « ¬ SHY ® ¯
//                              ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿
//   0x80–0x9F → the cp1252 "specials": € ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™
//                              š › œ ž Ÿ, plus five bytes (81 8D 8F 90 9D) cp1252
//                              does not map at all, which survive as bare C1 controls
//                              — 0x9D is exactly why the old class missed `”`.
// This set is the reason a two-character pattern is safe next to real prose: apart
// from ƒ Š š Œ œ Ž ž Ÿ it contains no letter of any living alphabet, so "café", "à la
// carte" and "Ça va" cannot match — an accented letter is never followed by one of
// these in text a human wrote.
const CONT =
  "\\u0080-\\u00bf" + // C1 controls and Latin-1 punctuation (incl. NBSP and SHY)
  "\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192" + // Œ œ Š š Ÿ Ž ž ƒ
  "\\u02c6\\u02dc" + // ˆ ˜
  "\\u2013\\u2014\\u2018\\u2019\\u201a\\u201c\\u201d\\u201e" + // – — ‘ ’ ‚ “ ” „
  "\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203a" + // † ‡ • … ‰ ‹ ›
  "\\u20ac\\u2122"; // € ™

/** Lead byte 0xE2 0x80 = the U+2000–U+203F punctuation block, whose third character
 *  is the only thing that varies: — – “ ” ‘ ’ … • † ‡ ‰ ‹ › all live here. */
const PUNCT = new RegExp(`â€[${CONT}]`);

// Order matters: the first match wins, so the specific fingerprints come first and
// only lend the report a better sentence. The generic three underneath them are what
// actually decide coverage.
export const FINGERPRINTS = [
  { pattern: /à[¸¹º]/, what: "Thai text re-encoded from a single-byte codepage" },
  { pattern: PUNCT, what: "punctuation (em dash / smart quotes / bullet) re-encoded" },
  { pattern: new RegExp(`Ã[${CONT}]`), what: "accented Latin re-encoded" },
  {
    // 0xC2–0xDF + 1: U+0080–U+07FF — Â· Â° Â© NBSP, and Greek/Cyrillic/Hebrew/Arabic.
    pattern: new RegExp(`[\\u00c2-\\u00df][${CONT}]`),
    what: "a 2-byte character (·, °, ©, NBSP, Greek/Cyrillic) re-encoded",
  },
  {
    // 0xE0–0xEF + 2: U+0800–U+FFFF — arrows, CJK, the rest of Thai.
    pattern: new RegExp(`[\\u00e0-\\u00ef][${CONT}][${CONT}]`),
    what: "a 3-byte character (→, CJK, Thai) re-encoded",
  },
  {
    // 0xF0–0xF4 + 3: U+10000 and above — emoji.
    pattern: new RegExp(`[\\u00f0-\\u00f4][${CONT}][${CONT}][${CONT}]`),
    what: "a 4-byte character (emoji) re-encoded",
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
