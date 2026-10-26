import { describe, expect, it } from "vitest";
import {
  clockSeconds,
  computeSetlistTimes,
  foldWaitsIntoNext,
  timingMeaning,
  deadlineInfo,
  formatClockOfDay,
  formatCountdown,
  formatDuration,
  formatOvertime,
  isSettled,
  monthBeforeKey,
  pad2,
  parseClockToSeconds,
  parseDurationToSeconds,
  runSecondsOf,
  SETTLE_AFTER_SEC,
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

// Live's countdown rounds UP (2026-10-25 hunt): 0:01 until the moment itself, so AUTO's
// 5 4 3 2 1, which reads the same number, lands each digit on its whole second.
describe("clockSeconds", () => {
  it("rounds a countdown up: a second is shown until it is over", () => {
    expect(clockSeconds(240)).toBe(240);
    expect(clockSeconds(239.999)).toBe(240);
    expect(clockSeconds(239.001)).toBe(240);
    expect(clockSeconds(239)).toBe(239);
    expect(clockSeconds(1)).toBe(1);
    expect(clockSeconds(0.3)).toBe(1);
    expect(clockSeconds(0)).toBe(0);
  });

  it("keeps a float a hair over a whole second on that second, and never says -0", () => {
    expect(clockSeconds(5.0000000001)).toBe(5);
    expect(clockSeconds(5 + 1e-6)).toBe(6);
    expect(Object.is(clockSeconds(-0.4), 0)).toBe(true);
  });

  it("past zero counts whole seconds over", () => {
    expect(clockSeconds(-0.99)).toBe(0);
    expect(clockSeconds(-1)).toBe(-1);
    expect(clockSeconds(-24.6)).toBe(-24);
    expect(formatOvertime(clockSeconds(-61.5))).toBe("+1:01");
  });
});

describe("formatOvertime", () => {
  it("signs overtime with + (never the countdown's -), at every length", () => {
    expect(formatOvertime(-24)).toBe("+0:24");
    expect(formatOvertime(-600)).toBe("+10:00");
    expect(formatOvertime(-3600)).toBe("+1:00:00");
  });

  it("is + whatever sign it is handed, and rounds like the countdown", () => {
    expect(formatOvertime(24)).toBe("+0:24");
    expect(formatOvertime(-0.4)).toBe("+0:00");
    expect(formatOvertime(-24.6)).toBe("+0:25");
  });
});

describe("isSettled", () => {
  it("settles the overtime plate from 10 s past zero, not before", () => {
    expect(SETTLE_AFTER_SEC).toBe(10);
    expect(isSettled(5)).toBe(false);
    expect(isSettled(0)).toBe(false);
    expect(isSettled(-9.9)).toBe(false);
    expect(isSettled(-10)).toBe(true);
    expect(isSettled(-600)).toBe(true);
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
  it("reads the Thai-written m.ss as minutes, never as seconds", () => {
    // Number("3.30") is 3.3 - this used to save a 3½-minute song as 0:03
    expect(parseDurationToSeconds("3.30")).toBe(210);
    expect(parseDurationToSeconds("1.05.30")).toBe(3930);
    expect(parseDurationToSeconds("3.5")).toBeNull(); // 3:05 or 3½ min? not a guess
    expect(parseDurationToSeconds("3:30.5")).toBeNull();
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

  // พี่ 2026-10-19 "ตั้งเวลา": a positive buffer_before is a wait after the row before -
  // counted on THAT row (its countdown runs on in silence), as Live Mode counts it.
  it("a wait before a row is the previous row's; a post-buffer is the row's own", () => {
    const r = computeSetlistTimes([item(100), item(180, 30, 60)]);
    expect(r.rows[0]).toMatchObject({ startSec: 0, endSec: 100, slotEndSec: 130, blockSeconds: 130 });
    expect(r.rows[1]).toMatchObject({
      slotStartSec: 130,
      startSec: 130,
      endSec: 310,
      slotEndSec: 370,
      blockSeconds: 240,
    });
    expect(r.totalSeconds).toBe(370);
  });

  it("the first row has no row before it: a number left there counts for nothing", () => {
    const r = computeSetlistTimes([item(180, 30)]);
    expect(r.rows[0]).toMatchObject({ startSec: 0, endSec: 180, blockSeconds: 180 });
    expect(r.totalSeconds).toBe(180);
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

  // พี่ 2026-10-17 "A จบตอน B เข้า": the overlap comes off the row it cuts short. It came off
  // the next one: song 1 read "จบ 3:00 · สะสม 3:00" while song 2 was already playing.
  it("ends a row the next one comes in over when it comes in; the next one keeps its length", () => {
    const r = computeSetlistTimes([item(180), item(180, -60)]);
    expect(r.rows[0]).toMatchObject({ startSec: 0, endSec: 120, slotEndSec: 120, blockSeconds: 120, accumulatedSec: 120 });
    expect(r.rows[1]).toMatchObject({ slotStartSec: 120, startSec: 120, endSec: 300, blockSeconds: 180, accumulatedSec: 300 });
    expect(r.rows[0].blockSeconds + r.rows[1].blockSeconds).toBe(r.totalSeconds);
  });

  it("an overlap into a row's buffer leaves its song whole and ends the buffer early", () => {
    // song 1 is 3:00 + 0:30 after; song 2 comes in 10 s before that buffer ends
    const r = computeSetlistTimes([item(180, 0, 30), item(180, -10)]);
    expect(r.rows[0]).toMatchObject({ endSec: 180, slotEndSec: 200, blockSeconds: 200, accumulatedSec: 200 });
    expect(r.rows[1]).toMatchObject({ startSec: 200, blockSeconds: 180 });
  });

  // An overlap that cannot pull a row before the start of the one above (a 0:00 MC, or a
  // lead longer than the row) leaves it coming in right where that row ends: its block
  // still took the lead off its own length (4:00 at -5 read 3:55).
  it("a lead that cannot move a row leaves its block its own length", () => {
    const r = computeSetlistTimes([item(120), item(0), item(240, -5)]);
    expect(r.rows[2]).toMatchObject({ startSec: 120, endSec: 360, blockSeconds: 240 });
    expect(r.rows.reduce((n, row) => n + row.blockSeconds, 0)).toBe(r.totalSeconds);
  });

  it("a row the next one starts over runs past the hard out only to where it ends", () => {
    // the hard out is at 2:30; song 1 (3:00) now ends at 2:00 under song 2
    const r = computeSetlistTimes([item(180), item(180, -60)], 0, 150);
    expect(r.rows[0].overHardOut).toBe(false);
    expect(r.rows[1].overHardOut).toBe(true);
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

  it("compares same-day hard out with no folding", () => {
    const start = 18 * 3600; // 18:00
    const hardOut = 22 * 3600; // 22:00, same day
    const r = computeSetlistTimes([item(3600), item(3600)], start, hardOut);
    expect(r.hardOutSec).toBe(hardOut);
    expect(r.isOver).toBe(false);
    expect(r.rows[1].overHardOut).toBe(false);
  });

  it("folds a past-midnight hard out forward when the set stays inside it", () => {
    // 23:00 show, 00:30 hard-out (a normal festival headliner close) — hardOutSec
    // is smaller than showStartSec in raw clock terms, which must NOT read as
    // already-over from the first row.
    const start = 23 * 3600; // 23:00
    const hardOut = 30 * 60; // 00:30
    const r = computeSetlistTimes([item(3600)], start, hardOut); // 23:00-00:00
    expect(r.hardOutSec).toBe(hardOut + 86400);
    expect(r.isOver).toBe(false);
    expect(r.overBy).toBe(0);
    expect(r.rows[0].overHardOut).toBe(false);
  });

  it("still flags a genuinely exceeded past-midnight hard out", () => {
    const start = 23 * 3600; // 23:00
    const hardOut = 30 * 60; // 00:30
    const r = computeSetlistTimes([item(5400)], start, hardOut); // 23:00-00:30, exactly on the line
    expect(r.rows[0].overHardOut).toBe(false);
    const over = computeSetlistTimes([item(5401)], start, hardOut); // one second past 00:30
    expect(over.isOver).toBe(true);
    expect(over.overBy).toBe(1);
    expect(over.rows[0].overHardOut).toBe(true);
  });
});

describe("monthBeforeKey", () => {
  it("steps back one calendar month", () => {
    expect(monthBeforeKey("2026-09-28")).toBe("2026-08-28");
    expect(monthBeforeKey("2026-01-15")).toBe("2025-12-15");
  });
  it("clamps to the end of a shorter month instead of rolling forward", () => {
    expect(monthBeforeKey("2026-03-31")).toBe("2026-02-28");
    expect(monthBeforeKey("2024-03-31")).toBe("2024-02-29");
    expect(monthBeforeKey("2026-05-31")).toBe("2026-04-30");
  });
});

describe("runSecondsOf - how long a row runs when the next one comes in over its end", () => {
  it("is the row's block less the next row's lead", () => {
    expect(runSecondsOf(240, 5)).toBe(235);
    expect(runSecondsOf(240, 0)).toBe(240);
  });
  it("never runs below 0, and a lead of nothing or less is none", () => {
    expect(runSecondsOf(10, 60)).toBe(0);
    expect(runSecondsOf(240, -5)).toBe(240);
    expect(runSecondsOf(0, 5)).toBe(0);
  });
});

// พี่ 2026-10-19: the old "เผื่อเวลาหลัง" becomes the next row's ตั้งเวลา - same run times.
describe("foldWaitsIntoNext", () => {
  const r = (sort_order: number, before: number, after: number) => ({
    sort_order,
    buffer_before_seconds: before,
    buffer_after_seconds: after,
    duration_seconds: 100,
  });
  it("moves each row's wait onto the row after it, netting out an overlap there", () => {
    const rows = [r(1, 0, 8), r(2, -5, 3), r(3, 0, 0)];
    const folded = foldWaitsIntoNext(rows);
    expect(folded.map((x) => [x.buffer_before_seconds, x.buffer_after_seconds])).toEqual([
      [0, 0],
      [3, 0], // -5 + 8
      [3, 0],
    ]);
    // the show runs exactly as long
    expect(computeSetlistTimes(folded).totalSeconds).toBe(computeSetlistTimes(rows).totalSeconds);
  });
  it("goes by sort_order, not by array order", () => {
    const folded = foldWaitsIntoNext([r(2, 0, 0), r(1, 0, 5)]);
    expect(folded.map((x) => [x.sort_order, x.buffer_before_seconds])).toEqual([
      [1, 0],
      [2, 5],
    ]);
  });
});

describe("timingMeaning", () => {
  it("says what a row's buffer_before does", () => {
    expect(timingMeaning(-5)).toBe("เล่นซ้อนเพลงก่อนหน้า 5 วิ");
    expect(timingMeaning(3)).toBe("รอ 3 วิ หลังเพลงก่อนหน้าจบ แล้วค่อยเริ่มเพลงนี้");
    expect(timingMeaning(0)).toBe("เริ่มทันทีที่เพลงก่อนหน้าจบ");
  });
});
