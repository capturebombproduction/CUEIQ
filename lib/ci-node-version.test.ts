import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE FOR "GREEN ON THIS MACHINE, RED ON CI".
//
// Round 11 shipped 810 passing tests, every local gate green, a verified production
// deploy — and CI went red on the very first push, twice, for the same reason: the
// workflows pinned Node 20 while this box runs Node 24. jsdom could not start a
// worker at all (undici calling markAsUncloneable, which Node 20 does not have), so
// the two jsdom projects — 310 of those 810 tests — silently did not run; and
// electron@42's postinstall was skipped with an EBADENGINE warning, so the offline
// smoke could not find a binary to launch.
//
// Neither failure is detectable from inside a test run on a machine with the right
// Node. What IS detectable is the mismatch itself: the toolchain declares what it
// needs, the workflows declare what they give it, and nothing compared the two.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, "..");

/** Every `node-version:` pin in every workflow, with its file for the message. */
function workflowNodePins(): { file: string; major: number }[] {
  const dir = path.join(repoRoot, ".github/workflows");
  const out: { file: string; major: number }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const m of text.matchAll(/node-version:\s*'?"?(\d+)/g)) {
      out.push({ file: name, major: Number(m[1]) });
    }
  }
  return out;
}

/** The `engines.node` of an installed package, or null when it is not installed
 *  here (the root CI job never installs desktop/, and that is fine — the desktop
 *  jobs do, and they read the same pins). */
function enginesOf(...relativeDirs: string[]): { pkg: string; range: string } | null {
  for (const rel of relativeDirs) {
    const file = path.join(repoRoot, rel, "package.json");
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    if (json?.engines?.node) return { pkg: json.name ?? rel, range: String(json.engines.node) };
  }
  return null;
}

/**
 * Is major version `major` admitted by an npm engines range?
 *
 * Deliberately NOT a full semver implementation — there is no semver package at the
 * root and adding one to answer a yes/no question about four strings is not worth a
 * dependency. It handles the two clause shapes npm packages actually use in
 * `engines.node`: a caret pinned to one major (`^24.15.0`) and a lower bound
 * (`>=22.19.0`, `>= 22.12.0`). Anything it cannot parse is treated as ADMITTING the
 * version, so this test can only ever fail on a mismatch it genuinely understood.
 */
function admitsMajor(range: string, major: number): boolean {
  const clauses = range.split("||").map((c) => c.trim());
  let understood = false;
  for (const clause of clauses) {
    const caret = /^\^\s*(\d+)\./.exec(clause);
    if (caret) {
      understood = true;
      if (Number(caret[1]) === major) return true;
      continue;
    }
    const gte = /^>=?\s*(\d+)\./.exec(clause);
    if (gte) {
      understood = true;
      if (major >= Number(gte[1])) return true;
      continue;
    }
  }
  // Nothing parseable → do not pretend to know.
  return !understood;
}

describe("CI runs a Node the toolchain can actually use", () => {
  const pins = workflowNodePins();

  it("finds a node-version pin in the workflows at all", () => {
    // If this ever reads zero, the regex above stopped matching (a quoted value, a
    // matrix, a reusable workflow) and every assertion below became vacuous.
    expect(pins.length).toBeGreaterThan(0);
  });

  it("pins the same major everywhere, so one file cannot drift", () => {
    const majors = [...new Set(pins.map((p) => p.major))];
    expect(
      majors,
      `workflows disagree about Node: ${pins.map((p) => `${p.file}=${p.major}`).join(", ")}`
    ).toHaveLength(1);
  });

  // jsdom is the one that took the whole jsdom half of the suite down without
  // failing a single assertion — the workers never started, and vitest reported the
  // 500 tests that DID run as a pass. electron is the one that left the offline
  // smoke with no binary. vitest and undici are here because they are the other two
  // that declare a floor.
  it.each([
    ["jsdom", ["node_modules/jsdom"]],
    ["electron", ["desktop/node_modules/electron"]],
    ["undici", ["node_modules/undici"]],
    ["vitest", ["node_modules/vitest"]],
  ])("%s accepts it", (_name, dirs) => {
    const engines = enginesOf(...dirs);
    if (!engines) return; // not installed in this job; the job that installs it checks
    const major = pins[0].major;
    expect(
      admitsMajor(engines.range, major),
      `CI pins Node ${major} but ${engines.pkg} declares engines.node "${engines.range}". ` +
        `Raise node-version in .github/workflows/*.yml — do NOT relax this test. ` +
        `A too-old Node here does not fail loudly: jsdom's workers refuse to start and ` +
        `vitest still reports the tests that did run as a pass, and electron's ` +
        `postinstall is skipped with a warning so the smoke finds no binary.`
    ).toBe(true);
  });

  it("is not older than the Node this suite is being run on", () => {
    // The machine that develops here is the machine that says "all green". If CI is
    // behind it, "all green" is a statement about a different runtime.
    const local = Number(process.versions.node.split(".")[0]);
    expect(
      pins[0].major,
      `CI pins Node ${pins[0].major} but this run is on Node ${local}. Everything verified ` +
        `here is verified on a newer runtime than CI uses, which is exactly how round 11 ` +
        `shipped a red pipeline behind a green local suite.`
    ).toBeGreaterThanOrEqual(local);
  });
});
