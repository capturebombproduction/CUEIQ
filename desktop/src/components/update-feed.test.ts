// desktop/electron/update-feed.cjs — the version arithmetic behind the header's update
// chip. A wrong answer here either hides a real update for good or nags about one that
// is already installed, and the Mac path has no other source of truth.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const feed = require("../../electron/update-feed.cjs") as {
  REPO: string;
  LATEST_YML_URL: string;
  parseVersion: (v: unknown) => number[] | null;
  isNewer: (a: unknown, b: unknown) => boolean;
  versionFromLatestYml: (t: unknown) => string | null;
  macDmgUrl: (v: string, arch: string, rosetta?: boolean) => string;
};

describe("update-feed", () => {
  it("compares versions numerically, not as text (0.1.10 is newer than 0.1.9)", () => {
    expect(feed.isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(feed.isNewer("0.1.25", "0.1.24")).toBe(true);
    expect(feed.isNewer("0.2.0", "0.1.99")).toBe(true);
    expect(feed.isNewer("v0.1.25", "0.1.24")).toBe(true);
  });

  it("never calls the same, an older, or an unreadable version an update", () => {
    expect(feed.isNewer("0.1.24", "0.1.24")).toBe(false);
    expect(feed.isNewer("0.1.23", "0.1.24")).toBe(false);
    expect(feed.isNewer("", "0.1.24")).toBe(false);
    expect(feed.isNewer(null, "0.1.24")).toBe(false);
    expect(feed.isNewer("0.1.25", "garbage")).toBe(false);
  });

  it("reads the version line of a real latest.yml", () => {
    const yml = [
      "version: 0.1.24",
      "files:",
      "  - url: CueIQ-0.1.24-Windows.exe",
      "    sha512: yq2dUEoaxLtMzXp7+n7jZBTXo3QHC82GDiliejXooueUAcGF5/qORGfvebuaWDATan3moy1Jv7cCRlz0KcEPtA==",
      "    size: 104054539",
      "path: CueIQ-0.1.24-Windows.exe",
      "releaseDate: '2026-10-03T04:01:12.345Z'",
    ].join("\n");
    expect(feed.versionFromLatestYml(yml)).toBe("0.1.24");
    expect(feed.versionFromLatestYml("version: '0.1.25'\n")).toBe("0.1.25");
    expect(feed.versionFromLatestYml("<html>Not Found</html>")).toBeNull();
  });

  it("offers each Mac its own .dmg, named the way the build renames them", () => {
    expect(feed.macDmgUrl("0.1.25", "arm64")).toBe(
      "https://github.com/capturebombproduction/CUEIQ/releases/download/v0.1.25/CueIQ-0.1.25-Mac-Apple-Silicon.dmg"
    );
    expect(feed.macDmgUrl("0.1.25", "x64")).toMatch(/CueIQ-0\.1\.25-Mac-Intel\.dmg$/);
    // an Intel build under Rosetta is on an Apple-Silicon machine
    expect(feed.macDmgUrl("0.1.25", "x64", true)).toMatch(/Mac-Apple-Silicon\.dmg$/);
    const rename = fs.readFileSync(path.resolve(__dirname, "../../build/rename-mac-arch.cjs"), "utf8");
    expect(rename).toContain("-Apple-Silicon.dmg");
    expect(rename).toContain("-Intel.dmg");
  });

  it("reads the same repository the Windows feed is published to", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
    const pub = pkg.build.win.publish[0];
    expect(feed.REPO).toBe(`${pub.owner}/${pub.repo}`);
    expect(feed.LATEST_YML_URL).toBe(`https://github.com/${pub.owner}/${pub.repo}/releases/latest/download/latest.yml`);
  });
});
