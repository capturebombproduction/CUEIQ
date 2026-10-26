import { describe, expect, it } from "vitest";
import { isShowTime, showTimeWindow, SHOW_LEAD_MS, SHOW_TAIL_MS } from "./show-time-window";

// Bangkok wall clock → epoch ms (UTC+7, no DST)
const bkk = (date: string, clock: string) => Date.parse(`${date}T${clock}:00+07:00`);

// WARUDO SHOW's shape (prod 2026-07-05): rows in running order, 10:00 → 20:30
const WARUDO = [
  { sort_order: 1, planned_start: "10:00:00", planned_end: "10:10:00" },
  { sort_order: 2, planned_start: "10:10:00", planned_end: "10:20:00" },
  { sort_order: 33, planned_start: "19:00:00", planned_end: "20:30:00" },
];

describe("showTimeWindow: the show's real date and time, from its own run order", () => {
  it("runs from 30 min before the first planned time to an hour after the last", () => {
    expect(showTimeWindow("2026-07-05", WARUDO)).toEqual({
      from: bkk("2026-07-05", "10:00") - SHOW_LEAD_MS,
      to: bkk("2026-07-05", "20:30") + SHOW_TAIL_MS,
    });
  });

  it("reads the rows in running order, whatever order they arrive in", () => {
    expect(showTimeWindow("2026-07-05", [...WARUDO].reverse())).toEqual(showTimeWindow("2026-07-05", WARUDO));
  });

  it("a run order that crosses midnight ends on the next day", () => {
    const late = [
      { sort_order: 1, planned_start: "22:00", planned_end: "23:30" },
      { sort_order: 2, planned_start: "23:30", planned_end: "00:30" },
      { sort_order: 3, planned_start: "00:30", planned_end: "01:15" },
    ];
    expect(showTimeWindow("2026-11-01", late)).toEqual({
      from: bkk("2026-11-01", "22:00") - SHOW_LEAD_MS,
      to: bkk("2026-11-02", "01:15") + SHOW_TAIL_MS,
    });
    expect(isShowTime("2026-11-01", late, bkk("2026-11-02", "00:40"))).toBe(true);
  });

  it("two rows that overlap (17:40-19:50, then 17:40-18:20) are not a midnight", () => {
    const rows = [
      { sort_order: 1, planned_start: "17:40", planned_end: "19:50" },
      { sort_order: 2, planned_start: "17:40", planned_end: "18:20" },
    ];
    expect(showTimeWindow("2026-07-04", rows)?.to).toBe(bkk("2026-07-04", "19:50") + SHOW_TAIL_MS);
  });

  it("a run order with no planned time at all = the whole Bangkok day", () => {
    expect(showTimeWindow("2026-07-05", [{ sort_order: 1, planned_start: null, planned_end: null }])).toEqual({
      from: bkk("2026-07-05", "00:00"),
      to: bkk("2026-07-06", "00:00"),
    });
  });

  it("no date = never show time (the real day cannot be known)", () => {
    expect(showTimeWindow(null, WARUDO)).toBeNull();
    expect(isShowTime(null, WARUDO, bkk("2026-07-05", "10:00"))).toBe(false);
  });
});

describe("isShowTime: a dry run is not the show", () => {
  it("the day before, at the same clock, is not show time", () => {
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-04", "10:00"))).toBe(false);
  });
  it("backstage two hours before the first row is not show time", () => {
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "08:00"))).toBe(false);
  });
  it("from 30 min before the first row it is", () => {
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "09:29"))).toBe(false);
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "09:30"))).toBe(true);
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "10:05"))).toBe(true);
  });
  it("a late show still counts until an hour after the last row", () => {
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "21:30"))).toBe(true);
    expect(isShowTime("2026-07-05", WARUDO, bkk("2026-07-05", "21:31"))).toBe(false);
  });
  it("Bangkok's date, not the server's UTC one (Vercel runs in UTC)", () => {
    const early = [{ sort_order: 1, planned_start: "06:00", planned_end: "07:00" }];
    // 06:00 BKK on the 5th is still the 4th in UTC
    expect(isShowTime("2026-07-05", early, bkk("2026-07-05", "06:00"))).toBe(true);
    expect(isShowTime("2026-07-04", early, bkk("2026-07-05", "06:00"))).toBe(false);
  });
});
