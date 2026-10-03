// SONG_SHOW_COLUMNS replaces "*" in the event bundle so the cover pictures stay out
// of it. The price of an explicit list is that a column added later is silently
// missing from every show (Live Mode reading a song with no audio_path plays
// nothing). So the list is pinned to the Song type: every field but `cover`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { SONG_SHOW_COLUMNS } from "./song-columns";

const TYPES = readFileSync(path.join(__dirname, "types.ts"), "utf8");

function songTypeKeys(): string[] {
  const body = /export interface Song \{([\s\S]*?)\n\}/.exec(TYPES)?.[1];
  if (!body) throw new Error("Song interface not found in lib/types.ts");
  return [...body.matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]);
}

const listed = SONG_SHOW_COLUMNS.split(",").map((c) => c.trim());

describe("SONG_SHOW_COLUMNS", () => {
  it("is every Song field except the cover", () => {
    const keys = songTypeKeys();
    expect(keys).toContain("cover"); // the parse found the real interface
    expect([...listed].sort()).toEqual(keys.filter((k) => k !== "cover").sort());
  });

  it("leaves the cover out and carries what a show runs on", () => {
    expect(listed).not.toContain("cover");
    expect(listed).not.toContain("*");
    for (const c of ["id", "title", "duration_seconds", "audio_path", "copyright_status"])
      expect(listed).toContain(c);
  });

  it("names each column once", () => {
    expect(new Set(listed).size).toBe(listed.length);
  });
});
