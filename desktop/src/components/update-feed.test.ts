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
  LATEST_MAC_YML_URL: string;
  macDmgName: (v: string, arch: string, rosetta?: boolean) => string;
  releaseAssetUrl: (v: string, name: string) => string;
  macFeedYml: (f: { version: string; files: FeedFile[]; releaseDate: string }) => string;
  parseFeedYml: (t: unknown) => { version: string; files: FeedFile[] } | null;
  macAssetFor: (
    feed: { version: string; files: FeedFile[] } | null,
    arch: string,
    rosetta?: boolean
  ) => FeedFile | null;
  macBundleFromExe: (p: unknown) => string | null;
  macBundleBlocker: (p: string | null) => string | null;
};
type FeedFile = { url: string; sha512: string; size: number };

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
    expect(feed.LATEST_MAC_YML_URL).toBe(
      `https://github.com/${pub.owner}/${pub.repo}/releases/latest/download/latest-mac.yml`
    );
  });
});

// The Mac's own feed: the build writes it (desktop/build/rename-mac-arch.cjs, macFeedYml) and
// the installed app reads it (main.cjs checkMacFeed, parseFeedYml). Its hash is the only thing
// standing between a download and the swap of the app the show runs on.
describe("latest-mac.yml", () => {
  const files: FeedFile[] = [
    { url: "CueIQ-0.1.26-Mac-Apple-Silicon.dmg", sha512: "AAAA+/b==", size: 123456789 },
    { url: "CueIQ-0.1.26-Mac-Intel.dmg", sha512: "BBBB+/c==", size: 120000000 },
  ];

  it("reads back exactly what the build writes", () => {
    const yml = feed.macFeedYml({ version: "0.1.26", files, releaseDate: "2026-10-04T01:02:03.000Z" });
    expect(feed.parseFeedYml(yml)).toEqual({ version: "0.1.26", files });
    expect(feed.versionFromLatestYml(yml)).toBe("0.1.26");
  });

  it("reads electron-builder's own layout too (quotes, CRLF, path/sha512 keys after the list)", () => {
    const yml = [
      "version: '0.1.27'",
      "files:",
      "  - url: CueIQ-0.1.27-Mac-Intel.dmg",
      "    sha512: 'ZZZ='",
      "    size: 99",
      "path: CueIQ-0.1.27-Mac-Intel.dmg",
      "sha512: ZZZ=",
      "releaseDate: '2026-10-04T00:00:00.000Z'",
    ].join("\r\n");
    expect(feed.parseFeedYml(yml)).toEqual({
      version: "0.1.27",
      files: [{ url: "CueIQ-0.1.27-Mac-Intel.dmg", sha512: "ZZZ=", size: 99 }],
    });
  });

  it("drops an entry it could not check (no hash or no size) and refuses a non-feed", () => {
    const yml = ["version: 0.1.26", "files:", "  - url: a.dmg", "    size: 5", "  - url: b.dmg", "    sha512: X=="].join(
      "\n"
    );
    expect(feed.parseFeedYml(yml)).toEqual({ version: "0.1.26", files: [] });
    expect(feed.parseFeedYml("<html>Not Found</html>")).toBeNull();
    expect(feed.parseFeedYml(undefined)).toBeNull();
  });

  it("gives each Mac its own .dmg from the feed, and nothing when the feed has none for it", () => {
    const parsed = { version: "0.1.26", files };
    expect(feed.macAssetFor(parsed, "arm64")?.url).toBe("CueIQ-0.1.26-Mac-Apple-Silicon.dmg");
    expect(feed.macAssetFor(parsed, "x64")?.url).toBe("CueIQ-0.1.26-Mac-Intel.dmg");
    expect(feed.macAssetFor(parsed, "x64", true)?.url).toBe("CueIQ-0.1.26-Mac-Apple-Silicon.dmg");
    expect(feed.macAssetFor({ version: "0.1.26", files: [files[1]] }, "arm64")).toBeNull();
    expect(feed.macAssetFor(null, "arm64")).toBeNull();
    // the name the feed lists is the name the download URL asks for
    expect(feed.macDmgUrl("0.1.26", "arm64")).toBe(
      feed.releaseAssetUrl("0.1.26", feed.macDmgName("0.1.26", "arm64"))
    );
  });
});

describe("can this Mac copy replace itself?", () => {
  it("finds the .app around the running executable", () => {
    expect(feed.macBundleFromExe("/Applications/CueIQ.app/Contents/MacOS/CueIQ")).toBe("/Applications/CueIQ.app");
    expect(feed.macBundleFromExe("/Users/p/Apps/CueIQ.app/Contents/MacOS/CueIQ")).toBe("/Users/p/Apps/CueIQ.app");
    expect(feed.macBundleFromExe("C:\\Program Files\\CueIQ\\CueIQ.exe")).toBeNull();
    expect(feed.macBundleFromExe("/usr/local/bin/electron")).toBeNull();
    expect(feed.macBundleFromExe(undefined)).toBeNull();
  });

  it("only from a real, moved-in install — never off the .dmg or a translocated copy", () => {
    expect(feed.macBundleBlocker("/Applications/CueIQ.app")).toBeNull();
    expect(feed.macBundleBlocker("/Volumes/CueIQ 0.1.26-arm64/CueIQ.app")).toBe("dmg");
    expect(feed.macBundleBlocker("/private/var/folders/x1/abc/T/AppTranslocation/1B2C/d/CueIQ.app")).toBe(
      "translocated"
    );
    expect(feed.macBundleBlocker(null)).toBe("not-bundle");
  });
});
