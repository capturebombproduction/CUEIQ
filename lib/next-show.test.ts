import { describe, it, expect } from "vitest";
import { earliestStartByEvent, practiceRoomByGroup, showTimesLabel } from "./next-show";

describe("earliestStartByEvent — the call time", () => {
  it("is each show's earliest timed row, whatever order the rows come in", () => {
    // the real 2026-09-20 day, shuffled
    const rows = [
      { event_id: "a", start_time: "13:20:00" }, // stage
      { event_id: "a", start_time: "15:15:00" }, // booth
      { event_id: "a", start_time: "11:20:00" }, // on_location
      { event_id: "a", start_time: null }, // a note row with no time
      { event_id: "b", start_time: "15:30:00" },
    ];
    expect(earliestStartByEvent(rows)).toEqual({ a: "11:20:00", b: "15:30:00" });
  });

  it("gives a show with no timed row no entry", () => {
    expect(earliestStartByEvent([{ event_id: "a", start_time: null }])).toEqual({});
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
