import { describe, it, expect } from "vitest";
import { bandLitVars, bandTriplet } from "@/lib/band-triplet";
import { spotFor } from "@/lib/skin";

// A hero lit in ANOTHER band's colour (Artists' own band, the Live Caller's act on
// stage; spec v3 §E.11 / §G.9 / §G.11) sets --lit inline for the key edge — and must
// set --lit-g too, or the glow takes --lit, the raw band colour, and a luminous band
// glows past the light ceiling.
describe("bandLitVars", () => {
  it("keys the edge in the band's colour and glows in its capped stage light", () => {
    expect(bandLitVars("#15a65a")).toEqual({ "--lit": bandTriplet("#15a65a"), "--lit-g": spotFor("#15a65a").dark });
    expect(bandLitVars("#15a65a")["--lit-g"]).toBe("149 93% 28%");
  });

  // groups.color is nullable and an offline cached row can lack it. The old fallback
  // keyed a muted edge and let the glow FOLLOW it — and inside `.lit` the muted ink is
  // --lit-muted-foreground (dark L80, luminance ≈ .59): a grey glow three times the
  // light ceiling, with the hero's own secondary text at ≈ 3.3:1. With no colour the
  // hero sets nothing and is lit like any other (the device's edge and capped light).
  it.each([null, undefined, "", "   ", "not-a-colour", "#12"])("%s: sets nothing, so the hero keeps the device's light", (hex) => {
    expect(bandLitVars(hex)).toEqual({});
  });
});
