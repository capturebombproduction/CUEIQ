import { describe, expect, it } from "vitest";
import {
  computeSetlistTimes,
  deadlineInfo,
  formatClockOfDay,
  formatCountdown,
  formatDuration,
  pad2,
  parseClockToSeconds,
  parseDurationToSeconds,
  shortClock,
} from "./time";

describe("pad2", () => {
  it("zero-pads to 2 digits, floors and abs-es", () => {
    expect(pad2(7)).toBe("07");
    expect(pad2(5.9)).toBe("05");
    expect(pad2(-5)).toBe("05");
    expect(pad2(123)).toBe("123");
  });
});

describe("formatDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatDuration(225)).toBe("3:45");
    expect(formatDuration(3930)).toBe("1:05:30");
    expect(formatDuration(0)).toBe("0:00");
  });
  it("clamps negatives to zero and rounds", () => {
    expect(formatDuration(-10)).toBe("0:00");
    expect(formatDuration(59.6)).toBe("1:00");
  });
});

describe("formatCountdown", () => {
  it("prefixes a minus once past zero (overtime)", () => {
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(-65)).toBe("-1:05");
    expect(formatCountdown(0)).toBe("0:00");
  });
});

describe("parseDurationToSeconds", () => {
  it("accepts ss / m:ss / h:mm:ss", () => {
    expect(parseDurationToSeconds("90")).toBe(90);
    expect(parseDurationToSeconds("3:45")).toBe(225);
    expect(parseDurationToSeconds("1:05:30")).toBe(3930);
    expect(parseDurationToSeconds(" 90 ")).toBe(90);
  });
  it("rejects blanks, non-numbers and negatives", () => {
    expect(parseDurationToSeconds("")).toBeNull();
    expect(parseDurationToSeconds("  ")).toBeNull();
    expect(parseDurationToSeconds("3:xx")).toBeNull();
    expect(parseDurationToSeconds("-5")).toBeNull();
    expect(parseDurationToSeconds("1:2:3:4")).toBeNull();
  });
});

describe("parseClockToSeconds", () => {
  it("parses HH:MM and HH:MM:SS into seconds-of-day", () => {
    expect(parseClockToSeconds("18:30")).toBe(66600);
    expect(parseClockToSeconds("18:30:15")).toBe(66615);
    expect(parseClockToSeconds("00:00")).toBe(0);
  });
  it("rejects nullish, out-of-range and malformed input", () => {
    expect(parseClockToSeconds(null)).toBeNull();
    expect(parseClockToSeconds(undefined)).toBeNull();
    expect(parseClockToSeconds("24:00")).toBeNull();
    expect(parseClockToSeconds("18:60")).toBeNull();
    expect(parseClockToSeconds("18:30:60")).toBeNull();
    expect(parseClockToSeconds("18")).toBeNull();
  });
});

describe("formatClockOfDay", () => {
  it("formats and wraps past midnight in both directions", () => {
    expect(formatClockOfDay(66600)).toBe("18:30");
    expect(formatClockOfDay(90000)).toBe("01:00"); // 25:00 wraps to 01:00
    expect(formatClockOfDay(-3600)).toBe("23:00"); // -1:00 wraps to 23:00
    expect(formatClockOfDay(66615, true)).toBe("18:30:15");
  });
});

describe("shortClock", () => {
  it("trims HH:MM:SS to HH:MM and passes bad input through", () => {
    expect(shortClock("18:30:15")).toBe("18:30");
    expect(shortClock("")).toBe("");
    expect(shortClock(null)).toBe("");
    expect(shortClock("not-a-clock")).toBe("not-a-clock");
  });
});

describe("deadlineInfo", () => {
  const now = new Date("2026-07-01T12:00:00+07:00");
  const at = (offsetHours: number) =>
    new Date(now.getTime() + offsetHours * 3_600_000).toISOString();

  it("returns null for no / invalid deadline", () => {
    expect(deadlineInfo(null, now)).toBeNull();
    expect(deadlineInfo("not-a-date", now)).toBeNull();
  });
  it("tones a deadline by how far out it is", () => {
    expect(deadlineInfo(at(-1), now)?.tone).toBe("overdue");
    expect(deadlineInfo(at(0.5), now)).toEqual({
      label: "ด่วน! เหลือไม่ถึง 1 ชม.",
      tone: "urgent",
    });
    expect(deadlineInfo(at(5), now)?.tone).toBe("urgent");
    expect(deadlineInfo(at(48), now)).toEqual({ label: "เหลือ 2 วัน", tone: "soon" });
    expect(deadlineInfo(at(100), now)?.tone).toBe("ok");
  });
});

describe("computeSetlistTimes — the run-sheet engine", () => {
  const item = (
    duration_seconds: number,
    buffer_before_seconds = 0,
    buffer_after_seconds = 0
  ) => ({ duration_seconds, buffer_before_seconds, buffer_after_seconds });

  it("lays two back-to-back songs end to end", () => {
    const r = computeSetlistTimes([item(180), item(240)]);
    expect(r.rows[0]).toMatchObject({ startSec: 0, endSec: 180, accumulatedSec: 180 });
    expect(r.rows[1]).toMatchObject({ startSec: 180, endSec: 420, accumulatedSec: 420 });
    expect(r.totalSeconds).toBe(420);
    expect(r.endSec).toBe(420);
    expect(r.isOver).toBe(false);
    expect(r.overBy).toBe(0);
  });

  it("offsets every time by the show start (seconds-of-day)", () => {
    const start = 18 * 3600; // 18:00
    const r = computeSetlistTimes([item(180)], start);
    expect(r.rows[0].startSec).toBe(start);
    expect(r.rows[0].endSec).toBe(start + 180);
    expect(r.rows[0].accumulatedSec).toBe(180); // accumulated is relative to start
  });

  it("applies pre/post buffers to the block", () => {
    const r = computeSetlistTimes([item(180, 30, 60)]);
    expect(r.rows[0]).toMatchObject({
      slotStartSec: 0,
      startSec: 30,
      endSec: 210,
      slotEndSec: 270,
      blockSeconds: 270,
    });
    expect(r.totalSeconds).toBe(270);
  });

  it("clamps a negative buffer_before on the FIRST item to zero", () => {
    const r = computeSetlistTimes([item(180, -60)]);
    expect(r.rows[0].startSec).toBe(0);
    expect(r.rows[0].endSec).toBe(180);
  });

  it("lets a negative buffer_before overlap the previous song but never run backwards", () => {
    const r = computeSetlistTimes([item(180), item(180, -60)]);
    // song 2 starts 60s before song 1 ends (continuous play), not before song 1 started
    expect(r.rows[1].startSec).toBe(120);
    expect(r.rows[1].endSec).toBe(300);
    expect(r.totalSeconds).toBe(300);
  });

  it("flags hard-out overruns per row and overall", () => {
    const r = computeSetlistTimes([item(180), item(240)], 0, 300);
    expect(r.isOver).toBe(true);
    expect(r.overBy).toBe(120);
    expect(r.rows[0].overHardOut).toBe(false);
    expect(r.rows[1].overHardOut).toBe(true);
  });

  it("handles an empty setlist", () => {
    const r = computeSetlistTimes([]);
    expect(r.rows).toEqual([]);
    expect(r.totalSeconds).toBe(0);
    expect(r.isOver).toBe(false);
  });
});
