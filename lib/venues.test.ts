import { describe, expect, it } from "vitest";
import { findVenuePreset } from "@/lib/venues";

describe("findVenuePreset", () => {
  it("the first keys of another venue are not Lot of Live", () => {
    // what the event form sees after each early key of "The Street Ratchada" etc.
    expect(findVenuePreset("T")).toBeUndefined();
    expect(findVenuePreset("I")).toBeUndefined();
    expect(findVenuePreset("Ba")).toBeUndefined();
    expect(findVenuePreset("Live")).toBeUndefined();
    expect(findVenuePreset("Lot")).toBeUndefined();
  });

  it("the preset's name, its start or a line containing it still match", () => {
    expect(findVenuePreset("Lot of Live (Bangkok)")?.mapUrl).toMatch(/goo\.gl/);
    expect(findVenuePreset("lot of live")?.mapUrl).toMatch(/goo\.gl/);
    expect(findVenuePreset("Lot of")?.mapUrl).toMatch(/goo\.gl/);
    expect(findVenuePreset("Lot of Live ชั้น 5")?.mapUrl).toMatch(/goo\.gl/);
  });

  it("another venue that merely starts the same way does not", () => {
    expect(findVenuePreset("Lot Fusion")).toBeUndefined();
  });
});
