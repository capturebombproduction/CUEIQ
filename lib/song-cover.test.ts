// Song covers (0044). jsdom has no canvas, so what is pinned is the logic around it: the
// square crop, the encoding choice (Safari's silent PNG fallback included), and that the
// client's idea of a valid cover is EXACTLY the database's - a cover the browser makes must
// never be one songs_cover_shape refuses, and the guard must keep covers editor-only.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { COVER_MAX_CHARS, COVER_SHAPE, isCoverDataUrl, pickEncoded, squareCrop } from "./song-cover";

const MIGRATION = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/0044_song_cover.sql"), "utf8");
const b64 = (n: number) => "A".repeat(n);

describe("squareCrop", () => {
  it("takes the centred square of a landscape, a portrait and a square picture", () => {
    expect(squareCrop(1600, 900)).toEqual({ sx: 350, sy: 0, side: 900 });
    expect(squareCrop(900, 1600)).toEqual({ sx: 0, sy: 350, side: 900 });
    expect(squareCrop(500, 500)).toEqual({ sx: 0, sy: 0, side: 500 });
  });
});

describe("pickEncoded", () => {
  it("takes WebP when the browser can encode it", () => {
    const out = pickEncoded((type) => `data:${type};base64,${b64(12000)}`);
    expect(out!.startsWith("data:image/webp;")).toBe(true);
  });

  it("Safari before 17 hands back a PNG for WebP: that is skipped for JPEG", () => {
    const out = pickEncoded((type) =>
      type === "image/webp" ? `data:image/png;base64,${b64(90000)}` : `data:${type};base64,${b64(15000)}`
    );
    expect(out!.startsWith("data:image/jpeg;")).toBe(true);
  });

  it("steps the quality down until it fits, and gives up (null) rather than store too much", () => {
    const sizes = [80000, 80000, 70000, 30000];
    let i = 0;
    const out = pickEncoded((type) => `data:${type};base64,${b64(sizes[Math.min(i++, sizes.length - 1)])}`);
    expect(out!.length).toBeLessThanOrEqual(COVER_MAX_CHARS);
    expect(pickEncoded((type) => `data:${type};base64,${b64(70000)}`)).toBeNull();
  });
});

describe("the client and the database agree on what a cover is", () => {
  it("isCoverDataUrl: an image data URL, base64, within the ceiling", () => {
    expect(isCoverDataUrl(`data:image/webp;base64,${b64(100)}==`)).toBe(true);
    expect(isCoverDataUrl(`data:image/jpeg;base64,${b64(100)}`)).toBe(true);
    expect(isCoverDataUrl(`data:image/svg+xml;base64,${b64(100)}`)).toBe(false); // no SVG: it can carry script
    expect(isCoverDataUrl(`https://example.com/a.jpg`)).toBe(false);
    expect(isCoverDataUrl(`data:image/webp;base64,${b64(COVER_MAX_CHARS)}`)).toBe(false);
    expect(isCoverDataUrl(null)).toBe(false);
  });

  it("songs_cover_shape in 0044 is the same pattern and the same ceiling", () => {
    const sqlRe = /cover ~ '([^']+)'/.exec(MIGRATION)![1];
    expect(sqlRe).toBe(COVER_SHAPE.source.replace(/\\\//g, "/"));
    expect(MIGRATION).toContain(`length(cover) <= ${COVER_MAX_CHARS}`);
  });

  it("guard_song_update keeps the cover editor-only (label staff and members cannot change it)", () => {
    expect(MIGRATION).toMatch(/or new\.cover\s+is distinct from old\.cover/);
  });
});
