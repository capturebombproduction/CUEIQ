import { describe, it, expect } from "vitest";
import { callTimeByEvent, callTimeOf, practiceRoomByGroup, showTimesLabel } from "./next-show";

describe("callTimeOf — the call time", () => {
  it("is the earliest row before the stage, whatever order the rows come in", () => {
    // the real 2026-09-20 day, shuffled
    const rows = [
      { kind: "stage", start_time: "13:20:00" },
      { kind: "booth", start_time: "15:15:00" },
      { kind: "on_location", start_time: "11:20:00" },
      { kind: "other", start_time: null }, // a note row with no time
    ];
    expect(callTimeOf(rows, "13:20:00")).toBe("11:20:00");
  });

  it("counts round the stage past midnight: a 00:30 booth is not the call for a 23:00 set", () => {
    const rows = [
      { kind: "on_location", start_time: "21:00:00" },
      { kind: "stage", start_time: "23:00:00" },
      { kind: "booth", start_time: "00:30:00" },
    ];
    expect(callTimeOf(rows, "23:00:00")).toBe("21:00:00");
  });

  it("has no call time when every timed row comes AFTER the set", () => {
    const rows = [
      { kind: "booth", start_time: "14:30:00" },
      { kind: "photo", start_time: "15:00:00" },
    ];
    expect(callTimeOf(rows, "13:00:00")).toBeNull();
  });

  it("with no show start, anchors on the stage row (as the copy dialog does)", () => {
    const rows = [
      { kind: "booth", start_time: "17:30:00" },
      { kind: "dressing_room", start_time: "15:30:00" },
      { kind: "stage", start_time: "17:00:00" },
    ];
    expect(callTimeOf(rows, null)).toBe("15:30:00");
  });

  it("with neither, falls back to the earliest row (the real Dok! Dok! day)", () => {
    const rows = [
      { kind: "on_location", start_time: "15:30:00" },
      { kind: "photo", start_time: "16:30:00" },
      { kind: "booth", start_time: "17:30:00" },
    ];
    expect(callTimeOf(rows, null)).toBe("15:30:00");
  });

  it("is null with no timed row", () => {
    expect(callTimeOf([{ kind: "other", start_time: null }], "13:00:00")).toBeNull();
  });

  it("callTimeByEvent groups rows by show and uses each show's own stage", () => {
    const rows = [
      { event_id: "a", kind: "on_location", start_time: "11:20:00" },
      { event_id: "a", kind: "stage", start_time: "13:20:00" },
      { event_id: "b", kind: "booth", start_time: "14:30:00" }, // after b's set only
    ];
    expect(callTimeByEvent(rows, { a: "13:20:00", b: "13:00:00" })).toEqual({ a: "11:20:00" });
  });
});

describe("showTimesLabel", () => {
  it("says both when the band is called before it goes on", () => {
    expect(showTimesLabel("11:20:00", "13:20:00")).toBe("นัด 11:20 · ขึ้นเวที 13:20");
  });
  it("says the call alone for a show with no stage time (the real Dok! Dok! case)", () => {
    expect(showTimesLabel("15:30:00", null)).toBe("นัด 15:30");
  });
  it("says the stage alone when there is no schedule", () => {
    expect(showTimesLabel(undefined, "13:00:00")).toBe("ขึ้นเวที 13:00");
  });
  it("says it once when the first row IS the set", () => {
    expect(showTimesLabel("13:00:00", "13:00:00")).toBe("ขึ้นเวที 13:00");
  });
  it("is null with neither", () => {
    expect(showTimesLabel(null, null)).toBeNull();
  });
});

describe("practiceRoomByGroup", () => {
  const rooms = [
    { id: "r-new", group_id: "g1" }, // newest first
    { id: "r-used", group_id: "g1" },
    { id: "r-other", group_id: "g2" },
  ];
  it("opens the room the band last practised in, not simply the newest", () => {
    const runs = [
      { event_id: "r-used", group_id: "g1" },
      { event_id: "r-new", group_id: "g1" },
    ];
    expect(practiceRoomByGroup(rooms, runs)).toEqual({ g1: "r-used", g2: "r-other" });
  });
  it("falls back to the newest room, and ignores runs in rooms that are gone", () => {
    const runs = [{ event_id: "deleted-room", group_id: "g1" }];
    expect(practiceRoomByGroup(rooms, runs).g1).toBe("r-new");
  });
  it("leaves out a band with no room at all", () => {
    expect(practiceRoomByGroup([], [{ event_id: "x", group_id: "g1" }])).toEqual({});
  });
});
