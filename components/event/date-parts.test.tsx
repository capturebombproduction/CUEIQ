import { describe, it, expect } from "vitest";
import { dateParts } from "./date-parts";

// The ticket's date block, the stub's date tile and the hero's day tile all read
// these pieces. A date-only key carries no zone: read as local midnight and printed
// in another zone, a show moves a day between the server and a Bangkok phone.
describe("dateParts", () => {
  it("splits a key into weekday, day, month and year, in English", () => {
    expect(dateParts("2026-10-04")).toEqual({ wd: "Sun", day: "04", mon: "Oct", year: "2026" });
  });

  it("is the same calendar day whatever zone runs it", () => {
    // 1 Jan is a Thursday in 2026; a local-midnight read west of UTC would say Wed 31 Dec.
    expect(dateParts("2026-01-01")).toMatchObject({ wd: "Thu", day: "01", mon: "Jan" });
  });

  it("three letters for September, not en-GB's “Sept”", () => {
    expect(dateParts("2026-09-25")?.mon).toBe("Sep");
  });

  it("null for a missing or garbled key (a cached row may have no date)", () => {
    expect(dateParts(null)).toBeNull();
    expect(dateParts(undefined)).toBeNull();
    expect(dateParts("")).toBeNull();
    expect(dateParts("x")).toBeNull();
  });
});
