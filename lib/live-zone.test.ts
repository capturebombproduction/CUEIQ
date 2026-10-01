import { describe, it, expect } from "vitest";
import { liveZone, thresholds, zoneCaption, type LiveZone } from "./live-zone";

// The ladder the founder set on 2026-10-01: WARN at <= 1 min, URGENT at <= 30 s,
// scaled to half / a quarter of a short item's block. The items below are the
// real shapes a Seishin show is made of — a full song, an SE, a VTR, a stinger.

const zoneAt = (blockSec: number, remaining: number, running = true): LiveZone =>
  liveZone({ running, remaining, blockSec });

describe("thresholds", () => {
  it("a full song gets the founder's caps: 1 minute, then 30 seconds", () => {
    expect(thresholds(228)).toEqual({ warn: 60, urgent: 30 }); // 3:48
  });

  it("a short item scales to half / a quarter of its block", () => {
    expect(thresholds(92)).toEqual({ warn: 46, urgent: 23 }); // 1:32 SE
    expect(thresholds(60)).toEqual({ warn: 30, urgent: 15 }); // 1:00 VTR
    expect(thresholds(20)).toEqual({ warn: 10, urgent: 5 }); // 0:20 stinger
  });

  it("whole seconds only — the caption names this number", () => {
    expect(thresholds(15)).toEqual({ warn: 7, urgent: 3 });
  });

  it("a missing or nonsense block length yields zero thresholds, not NaN", () => {
    expect(thresholds(0)).toEqual({ warn: 0, urgent: 0 });
    expect(thresholds(-30)).toEqual({ warn: 0, urgent: 0 });
    expect(thresholds(Number.NaN)).toEqual({ warn: 0, urgent: 0 });
  });
});

describe("liveZone — the ladder on real items", () => {
  it("3:48 song: ok until a minute is left, then warn, then urgent, then over", () => {
    expect(zoneAt(228, 228)).toBe("ok");
    // the OLD ladder had this song amber from 5:00 down — i.e. its whole length
    expect(zoneAt(228, 200)).toBe("ok");
    expect(zoneAt(228, 61)).toBe("ok");
    expect(zoneAt(228, 60)).toBe("warn");
    expect(zoneAt(228, 31)).toBe("warn");
    expect(zoneAt(228, 30)).toBe("urgent");
    expect(zoneAt(228, 0.4)).toBe("urgent");
    expect(zoneAt(228, 0)).toBe("over");
    expect(zoneAt(228, -12)).toBe("over");
  });

  it("1:32 SE: no longer red from its first second", () => {
    expect(zoneAt(92, 92)).toBe("ok");
    expect(zoneAt(92, 47)).toBe("ok");
    expect(zoneAt(92, 46)).toBe("warn");
    expect(zoneAt(92, 24)).toBe("warn");
    expect(zoneAt(92, 23)).toBe("urgent");
    expect(zoneAt(92, 0)).toBe("over");
  });

  it("1:00 VTR: a block that IS the warn cap still starts ok", () => {
    expect(zoneAt(60, 60)).toBe("ok");
    expect(zoneAt(60, 31)).toBe("ok");
    expect(zoneAt(60, 30)).toBe("warn");
    expect(zoneAt(60, 16)).toBe("warn");
    expect(zoneAt(60, 15)).toBe("urgent");
    expect(zoneAt(60, 0)).toBe("over");
  });

  it("0:20 item: warn at 10 s, urgent at 5 s", () => {
    expect(zoneAt(20, 20)).toBe("ok");
    expect(zoneAt(20, 11)).toBe("ok");
    expect(zoneAt(20, 10)).toBe("warn");
    expect(zoneAt(20, 6)).toBe("warn");
    expect(zoneAt(20, 5)).toBe("urgent");
    expect(zoneAt(20, 0)).toBe("over");
  });

  it("boundaries are inclusive: exactly 60 / 30 / 0 land in the next zone down", () => {
    expect(zoneAt(600, 60.001)).toBe("ok");
    expect(zoneAt(600, 60)).toBe("warn");
    expect(zoneAt(600, 30.001)).toBe("warn");
    expect(zoneAt(600, 30)).toBe("urgent");
    expect(zoneAt(600, 0.001)).toBe("urgent");
    expect(zoneAt(600, 0)).toBe("over");
  });

  it("nothing warns from its first second, whatever its length", () => {
    for (let block = 1; block <= 900; block++) {
      expect(zoneAt(block, block), `block ${block}s at its start`).toBe("ok");
    }
  });

  it("an empty block (no duration) is over the moment it runs — as before", () => {
    expect(zoneAt(0, 0)).toBe("over");
  });

  it("not running → ok, even past the end — a paused or cued card stays neutral", () => {
    expect(zoneAt(228, 228, false)).toBe("ok");
    expect(zoneAt(228, 45, false)).toBe("ok");
    expect(zoneAt(228, 10, false)).toBe("ok");
    expect(zoneAt(228, -40, false)).toBe("ok");
  });
});

describe("zoneCaption", () => {
  it("names a minute when the threshold is the full 60 s", () => {
    expect(zoneCaption("warn", 228)).toBe("เหลือไม่ถึง 1 นาที");
    expect(zoneCaption("urgent", 228)).toBe("เหลือไม่ถึง 30 วินาที");
  });

  it("names the item's own scaled threshold in seconds otherwise", () => {
    expect(zoneCaption("warn", 92)).toBe("เหลือไม่ถึง 46 วินาที");
    expect(zoneCaption("urgent", 92)).toBe("เหลือไม่ถึง 23 วินาที");
    // a VTR's WARN threshold is 30 s — the caption must say 30, not "1 นาที"
    expect(zoneCaption("warn", 60)).toBe("เหลือไม่ถึง 30 วินาที");
    expect(zoneCaption("urgent", 60)).toBe("เหลือไม่ถึง 15 วินาที");
    expect(zoneCaption("warn", 20)).toBe("เหลือไม่ถึง 10 วินาที");
    expect(zoneCaption("urgent", 20)).toBe("เหลือไม่ถึง 5 วินาที");
    expect(zoneCaption("warn", 15)).toBe("เหลือไม่ถึง 7 วินาที");
  });

  it("over and ok keep today's wording", () => {
    expect(zoneCaption("over", 228)).toBe("เลยเวลาแล้ว");
    expect(zoneCaption("ok", 228)).toBe("เวลาคงเหลือของรายการ");
  });
});
