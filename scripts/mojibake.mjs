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
// encoding-check: this file contains deliberate mojibake samples — a detector has to
// contain what it detects, and loosening the patterns until they stop matching their
// own examples would blind it to the real thing.
export const FINGERPRINTS = [
  { pattern: /à[¸¹º]/, what: "Thai text re-encoded from a single-byte codepage" },
  // An em dash (E2 80 94) becomes "â" + cp1252's 0x80 (€) + 0x94 (”). The class
  // covers the punctuation this repo actually uses: — – “ ” ‘ ’ … •
  {
    pattern: /â[€][“”‘’–—˜™œ¦],?/,
    what: "punctuation (em dash / smart quotes) re-encoded",
  },
  { pattern: /Ã[©¨¤¶¼½¡±]/, what: "accented Latin re-encoded" },
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
