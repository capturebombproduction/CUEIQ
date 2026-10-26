// Hunt 3 (2026-10-27), overview-3. 17b15ef replaced the ±12 h window with "before 06:00 after an
// evening (>= 15:00) show = the next day". An upcountry show's early departure / call
// (05:00 for a 16:00 stage, 11 h before it) was FIRST under c4388cf's window and is now
// printed LAST on the run sheet / JPG and the members' Schedule timeline.
import { describe, it, expect } from "vitest";
import { dayOrderSeconds } from "@/lib/clone-event";

const at = (c: string) => {
  const [h, m] = c.split(":").map(Number);
  return h * 3600 + m * 60;
};

describe("dayOrderSeconds: an early-morning call for an afternoon/evening show", () => {
  it("05:00 departure sorts before a 16:00 stage", () => {
    const anchor = at("16:00");
    const rows = ["16:00", "05:00", "14:00"].sort(
      (a, b) => dayOrderSeconds(a, anchor) - dayOrderSeconds(b, anchor)
    );
    expect(rows).toEqual(["05:00", "14:00", "16:00"]);
  });
  it("an after-midnight booth still follows an evening show", () => {
    const anchor = at("18:30");
    const rows = ["01:30", "18:30", "17:00"].sort(
      (a, b) => dayOrderSeconds(a, anchor) - dayOrderSeconds(b, anchor)
    );
    expect(rows).toEqual(["17:00", "18:30", "01:30"]);
  });
  it("a late row before a small-hours show is the day before", () => {
    const anchor = at("01:00");
    const rows = ["01:00", "22:00", "03:00"].sort(
      (a, b) => dayOrderSeconds(a, anchor) - dayOrderSeconds(b, anchor)
    );
    expect(rows).toEqual(["22:00", "01:00", "03:00"]);
  });
});
