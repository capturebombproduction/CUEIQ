import { describe, expect, it } from "vitest";
import { formatBytes } from "./show-readiness";

// The compact storage label shown in the pre-show readiness check. A wrong label
// misleads the operator about whether there's room for the show's audio, so pin
// the unit boundaries.
describe("formatBytes", () => {
  it("shows a dash for unknown", () => {
    expect(formatBytes(null)).toBe("—");
  });
  it("floors tiny values to <0.1 MB", () => {
    expect(formatBytes(0)).toBe("<0.1 MB");
    expect(formatBytes(50 * 1024)).toBe("<0.1 MB"); // 50 KB
  });
  it("shows one decimal under 10 MB, none from 10 MB up", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
  });
  it("switches to GB at 1024 MB", () => {
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});
