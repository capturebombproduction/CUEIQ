// Fails if any tracked text file has had its UTF-8 mangled.
//
//   node scripts/check-encoding.mjs
//
// WHY THIS IS A GATE. Round 10 nearly shipped mojibake into a live confirm dialog:
// `Get-Content -Raw | Set-Content -Encoding UTF8` in Windows PowerShell 5.1 reads a
// UTF-8-without-BOM file as ANSI and re-encodes it, turning every Thai string in the
// file into `à¸šà¸­à¸£à¹Œà¸”`. tsc, lint and 394 tests all stayed green, because NO
// GATE IN THIS REPO READS THAI. This one does — it is the only gate whose subject is
// the bytes rather than the syntax.
//
// Deliberately narrow: it does not lint copy, has no opinion about wording, and does
// not care which language a file is in. It answers one question — did the bytes
// survive? The detection itself lives in scripts/mojibake.mjs and is unit-tested
// (lib/mojibake.test.ts), because a detector nobody ever fired is exactly the kind of
// guard this project keeps shipping as a silent no-op.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findMojibake } from "./mojibake.mjs";

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".sql", ".yml",
  ".yaml", ".css", ".html", ".txt",
]);

// A file may opt out by containing this marker. Exactly three do, and all three are
// this gate's own machinery: a mojibake detector and its tests have to CONTAIN
// mojibake. The alternative — loosening the patterns until the detector stops
// matching its own examples — would blind it to the real thing, which is the one
// outcome worse than a false positive here.
//
// It is a marker in the file rather than a path list on purpose: a rename cannot
// silently un-exempt (or, worse, silently exempt) anything, the exemption is visible
// to whoever reads the file, and every run prints who opted out.
const OPT_OUT = "encoding-check: this file contains deliberate mojibake samples";

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const problems = [];
const exempt = [];
for (const file of trackedFiles()) {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue; // deleted between ls-files and here, or unreadable — not our business
  }
  if (text.includes(OPT_OUT)) {
    exempt.push(file);
    continue;
  }
  for (const hit of findMojibake(text)) problems.push({ file, ...hit });
}

// Printed on every run, pass or fail: an exemption nobody sees is an exemption that
// grows.
if (exempt.length > 0) console.log(`encoding check: skipping ${exempt.length} opted-out file(s): ${exempt.join(", ")}`);

if (problems.length > 0) {
  // Capped: a whole file round-tripped through PowerShell yields hundreds of these
  // and the first few already say everything.
  for (const p of problems.slice(0, 25)) {
    console.error(
      `::error file=${p.file},line=${p.line}::${p.what} — ${p.text.trim().slice(0, 120)}`
    );
  }
  if (problems.length > 25) console.error(`…and ${problems.length - 25} more`);
  console.error(
    `\nencoding check FAILED: ${problems.length} line(s) across ` +
      `${new Set(problems.map((p) => p.file)).size} file(s).\n` +
      `Almost always the cause is a source file round-tripped through Windows ` +
      `PowerShell 5.1. Restore the file from git and redo the edit with an editor ` +
      `that writes UTF-8, or with node reading and writing 'utf8' explicitly.`
  );
  process.exit(1);
}

console.log("encoding check: every tracked text file is intact UTF-8");
// encoding-check: this file contains deliberate mojibake samples (the à¸-shaped
// example in the header above is the whole point of the gate).
