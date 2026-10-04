import { describe, it, expect } from "vitest";
import { hardOutAtMs, hardOutGap, hardOutReading } from "./live-hard-out";

// Local-time dates throughout: the hard out is a wall-clock time at the venue.
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("hardOutAtMs", () => {
  it("is the event's day at the hard-out time, in local time", () => {
    expect(hardOutAtMs("2026-10-04", "15:15:00", "18:30:00")).toBe(at(2026, 10, 4, 18, 30));
  });
  it("a hard out earlier in the clock than the show start is the next morning", () => {
    expect(hardOutAtMs("2026-10-04", "23:00:00", "00:30:00")).toBe(at(2026, 10, 5, 0, 30));
  });
  it("no start time: taken as the same day", () => {
    expect(hardOutAtMs("2026-10-04", null, "00:30:00")).toBe(at(2026, 10, 4, 0, 30));
  });
  it("nothing to read without a date or a time", () => {
    expect(hardOutAtMs(null, "15:15:00", "18:30:00")).toBeNull();
    expect(hardOutAtMs("2026-10-04", "15:15:00", null)).toBeNull();
    expect(hardOutAtMs("04/10/2026", "15:15:00", "18:30:00")).toBeNull();
  });
});

describe("hardOutReading", () => {
  const base = { eventDate: "2026-10-04", showStartTime: "15:15:00", hardOutTime: "18:30:00" };

  it("ends before the hard out: the margin, not over", () => {
    const r = hardOutReading({ ...base, projectedEndMs: at(2026, 10, 4, 18, 27), nowMs: at(2026, 10, 4, 18, 0) });
    expect(r).toEqual({ clock: "18:30", marginSec: 180, over: false });
    expect(hardOutGap(r!)).toBe("ก่อน 3:00");
  });

  it("runs past it: over, by how much", () => {
    const r = hardOutReading({ ...base, projectedEndMs: at(2026, 10, 4, 18, 32, 10), nowMs: at(2026, 10, 4, 18, 10) });
    expect(r?.over).toBe(true);
    expect(r?.marginSec).toBe(-130);
    expect(hardOutGap(r!)).toBe("เกิน 2:10");
  });

  it("exactly on it is not over", () => {
    const r = hardOutReading({ ...base, projectedEndMs: at(2026, 10, 4, 18, 30), nowMs: at(2026, 10, 4, 18, 0) });
    expect(r?.over).toBe(false);
  });

  it("only around the show: a rehearsal days before, or the next day, reads nothing", () => {
    const days = (n: number) => at(2026, 10, 4 + n, 20, 0);
    expect(hardOutReading({ ...base, projectedEndMs: days(-3), nowMs: days(-3) })).toBeNull();
    expect(hardOutReading({ ...base, projectedEndMs: days(1), nowMs: days(1) })).toBeNull();
    // the morning of the show does
    expect(hardOutReading({ ...base, projectedEndMs: at(2026, 10, 4, 10, 20), nowMs: at(2026, 10, 4, 10, 0) })).not.toBeNull();
  });

  it("past midnight: a 23:00 show with a 00:30 hard out is read at 23:50, not 'over by a day'", () => {
    const r = hardOutReading({
      eventDate: "2026-10-04",
      showStartTime: "23:00:00",
      hardOutTime: "00:30:00",
      projectedEndMs: at(2026, 10, 5, 0, 20),
      nowMs: at(2026, 10, 4, 23, 50),
    });
    expect(r).toEqual({ clock: "00:30", marginSec: 600, over: false });
  });

  it("no hard out on the event: nothing", () => {
    expect(hardOutReading({ ...base, hardOutTime: null, projectedEndMs: 0, nowMs: at(2026, 10, 4, 18, 0) })).toBeNull();
  });
});
