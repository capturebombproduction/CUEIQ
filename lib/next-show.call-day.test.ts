// A show called the evening BEFORE its date. 2026-10-30, hunt 11: the morning push and the
// Next Show ticket keyed "พรุ่งนี้" / "วันนี้" on event_date alone, so the day before a 00:30
// stage called at 22:30 said "โชว์พรุ่งนี้ — นัด 22:30" about a call that was that same night.
// callDayOffset says which day the call is on, by callTimeOf's own short-way-round rule;
// every ordinary show (the call before the stage, same day) is 0, so nothing else moves.
import { describe, it, expect } from "vitest";
import { callDayOffset, callTimeOf, showReminderBody } from "./next-show";

describe("callDayOffset", () => {
  it("is 0 for the two real shows of 10-31 and 11-01 (call 15 min before an afternoon stage)", () => {
    expect(callDayOffset("17:25:00", "17:40:00")).toBe(0);
    expect(callDayOffset("13:25:00", "13:40:00")).toBe(0);
  });

  it("is -1 for a small-hours stage called the evening before", () => {
    expect(callDayOffset("22:30:00", "00:30:00")).toBe(-1);
    expect(callDayOffset("23:50", "00:10")).toBe(-1);
    // the call callTimeOf actually picks for such a show
    const call = callTimeOf([{ start_time: "22:30:00", kind: "call" }, { start_time: "01:30:00", kind: "booth" }], "00:30:00");
    expect(call).toBe("22:30:00");
    expect(callDayOffset(call, "00:30:00")).toBe(-1);
  });

  it("is 0 for a late show whose call and stage are both before midnight", () => {
    expect(callDayOffset("21:40:00", "23:40:00")).toBe(0);
  });

  it("is 0 without a call or a stage", () => {
    expect(callDayOffset(null, "00:30:00")).toBe(0);
    expect(callDayOffset("22:30:00", null)).toBe(0);
    expect(callDayOffset(undefined, undefined)).toBe(0);
  });

  it("leaves the reminder body of the real shows exactly as it was", () => {
    expect(showReminderBody("Ichiban idol vol.26 Halloween", "Seishin Kakumei", "17:25:00", "17:40:00")).toBe(
      "Ichiban idol vol.26 Halloween · Seishin Kakumei — นัด 17:25 · ขึ้นเวที 17:40"
    );
    expect(showReminderBody("Reborn into into a new me", "Seishin Kakumei", "13:25:00", "13:40:00")).toBe(
      "Reborn into into a new me · Seishin Kakumei — นัด 13:25 · ขึ้นเวที 13:40"
    );
  });
});
