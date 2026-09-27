import { describe, it, expect } from "vitest";
import { lineupStatus, memberLabel } from "./lineup";

const band = [
  { id: "a", name: "Aya Mori", nickname: "Aya" },
  { id: "b", name: "Bell Chan", nickname: null },
  { id: "c", name: "Cee Kao", nickname: "  " },
];

describe("lineupStatus", () => {
  it("splits the band into who comes and who does not, in band order", () => {
    const s = lineupStatus(band, ["c", "a"]);
    expect(s.chosen).toBe(true);
    expect(s.present.map((m) => m.id)).toEqual(["a", "c"]);
    expect(s.absent.map((m) => m.id)).toEqual(["b"]);
  });

  it("an empty lineup is NOT chosen — whole band shown, nobody marked absent", () => {
    const s = lineupStatus(band, []);
    expect(s.chosen).toBe(false);
    expect(s.present).toHaveLength(3);
    expect(s.absent).toEqual([]);
  });

  it("a lineup row for a member who left the band does not inflate the count", () => {
    const s = lineupStatus(band, ["a", "b", "gone"]);
    expect(s.present).toHaveLength(2);
    expect(s.absent.map((m) => m.id)).toEqual(["c"]);
  });
});

describe("memberLabel", () => {
  it("prefers the nickname, falling back to the name when it is blank", () => {
    expect(band.map(memberLabel)).toEqual(["Aya", "Bell Chan", "Cee Kao"]);
  });
});
