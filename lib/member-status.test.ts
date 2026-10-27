// A member who has left (members.left_at, 0054) is kept for history: in the shows dated on or
// before their leaving day (Bangkok) and in any lineup that holds them; out of later shows,
// undated ones and today's roster. The same rule as get_shared_event in 0054.
import { describe, expect, it } from "vitest";
import { currentMembers, hasLeft, leftOnKey, membersForShow } from "@/lib/member-status";

const stays = { id: "a", left_at: null };
// left 2026-10-27 at 08:00 Bangkok (01:00 UTC)
const leaves = { id: "b", left_at: "2026-10-27T01:00:00Z" };
const old: { id: string; left_at?: string | null } = { id: "c" }; // read before 0054: no field

describe("member-status", () => {
  it("reads in the band from null or a missing field", () => {
    expect(hasLeft(stays)).toBe(false);
    expect(hasLeft(old)).toBe(false);
    expect(hasLeft(leaves)).toBe(true);
    expect(currentMembers([stays, leaves, old]).map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("gives the leaving day in Bangkok, not UTC", () => {
    expect(leftOnKey(leaves)).toBe("2026-10-27");
    // 23:30 Bangkok on 10-26 is 16:30 UTC; 00:30 Bangkok on 10-27 is 17:30 UTC on 10-26
    expect(leftOnKey({ left_at: "2026-10-26T16:30:00Z" })).toBe("2026-10-26");
    expect(leftOnKey({ left_at: "2026-10-26T17:30:00Z" })).toBe("2026-10-27");
    expect(leftOnKey({ left_at: "not a date" })).toBeNull();
  });

  it("keeps a left member for a show on or before the leaving day, drops them after", () => {
    const ids = (eventDate: string | null) =>
      membersForShow([stays, leaves, old], { eventDate }).map((m) => m.id);
    expect(ids("2026-09-01")).toEqual(["a", "b", "c"]);
    expect(ids("2026-10-27")).toEqual(["a", "b", "c"]); // they played that day
    expect(ids("2026-11-05")).toEqual(["a", "c"]);
    expect(ids(null)).toEqual(["a", "c"]); // undated = planned now
  });

  it("keeps a left member a later show's lineup still holds", () => {
    expect(
      membersForShow([stays, leaves], { eventDate: "2026-11-05", lineup: ["b"] }).map((m) => m.id)
    ).toEqual(["a", "b"]);
  });
});
