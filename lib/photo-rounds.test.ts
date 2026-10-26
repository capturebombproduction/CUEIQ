import { describe, expect, it } from "vitest";
import { photoRoundsOf } from "@/lib/photo-rounds";

const row = (id: string, label: string | null, start: string | null, sort = 0, kind = "photo") => ({
  id,
  kind,
  label,
  start_time: start,
  end_time: null,
  sort_order: sort,
});

describe("photoRoundsOf", () => {
  it("no photo rows → no main, nothing more", () => {
    expect(photoRoundsOf([row("s", null, "14:00", 1, "stage")])).toEqual({ main: null, more: [] });
  });

  it("the unnamed round is main even when a named one is earlier or first by id", () => {
    const r = photoRoundsOf([row("0a", "รอบ 2", "11:00", 5), row("9f", null, "13:00", 3)]);
    expect(r.main?.id).toBe("9f");
    expect(r.more).toEqual([{ start: "11:00", end: null, label: "รอบ 2" }]);
  });

  it("a round named ถ่ายรูป (what the Overview cell inserts) is the main round", () => {
    const r = photoRoundsOf([row("a", "ชุด 2", "16:00"), row("b", " ถ่ายรูป ", "13:00")]);
    expect(r.main?.id).toBe("b");
  });

  it("only named rounds → the earliest is main, the rest follow in time order", () => {
    const r = photoRoundsOf([
      row("c", "ชุด 3", "18:00"),
      row("a", "ชุด 1", "12:00"),
      row("b", "ชุด 2", "15:00"),
    ]);
    expect(r.main?.id).toBe("a");
    expect(r.more.map((m) => m.label)).toEqual(["ชุด 2", "ชุด 3"]);
  });

  it("a round with no time yet sorts last", () => {
    const r = photoRoundsOf([row("a", "ชุด 1", null, 1), row("b", "ชุด 2", "15:00", 2)]);
    expect(r.main?.id).toBe("b");
  });
});
