// dayOrderSeconds: how the run sheet (event-summary) and the Schedule timeline order a
// show's day. 2026-10-27: plain clock order, except across midnight - the ±12 h window
// it replaced also moved a 06:00 call for an 18:30 show, and a 22:30 second stage after
// a 10:00 one, to the wrong end of the day.
import { describe, it, expect } from "vitest";
import { dayOrderSeconds } from "./clone-event";

const at = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return h * 3600 + m * 60;
};
const order = (anchor: string | null, clocks: string[]) =>
  [...clocks].sort(
    (a, b) => dayOrderSeconds(a, anchor == null ? null : at(anchor)) - dayOrderSeconds(b, anchor == null ? null : at(anchor))
  );

describe("dayOrderSeconds", () => {
  it("an evening show: its after-midnight booth comes last", () => {
    expect(order("23:00", ["00:30", "21:00", "23:00"])).toEqual(["21:00", "23:00", "00:30"]);
  });
  it("an evening show: a 06:00 call stays first (it is not after midnight)", () => {
    expect(order("18:30", ["18:30", "06:00", "19:30"])).toEqual(["06:00", "18:30", "19:30"]);
  });
  it("a long daytime day: a 22:30 second stage comes after the 10:00 one", () => {
    expect(order("10:00", ["22:30", "10:00", "08:00"])).toEqual(["08:00", "10:00", "22:30"]);
  });
  it("a festival slot at noon: a 19:00 booth comes after it", () => {
    expect(order("12:00", ["19:00", "12:00", "10:00"])).toEqual(["10:00", "12:00", "19:00"]);
  });
  it("a small-hours show: the evening call before it comes first", () => {
    expect(order("01:00", ["01:00", "22:00", "02:00"])).toEqual(["22:00", "01:00", "02:00"]);
  });
  it("no anchor: the plain clock; no time: last", () => {
    expect(order(null, ["00:30", "21:00"])).toEqual(["00:30", "21:00"]);
    expect(dayOrderSeconds(null, at("18:00"))).toBe(Number.POSITIVE_INFINITY);
  });
});
