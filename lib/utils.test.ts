import { describe, expect, it } from "vitest";
import { safeInternalPath } from "@/lib/utils";

// The post-login `?next=`: an in-app path, or the dashboard - never another site.
describe("safeInternalPath", () => {
  it("keeps an in-app path, query and hash included", () => {
    expect(safeInternalPath("/events/abc?tab=setlist#x")).toBe("/events/abc?tab=setlist#x");
  });

  it("refuses an absolute or protocol-relative target", () => {
    expect(safeInternalPath("https://evil.example")).toBe("/dashboard");
    expect(safeInternalPath("//evil.example")).toBe("/dashboard");
    expect(safeInternalPath("/\\evil.example")).toBe("/dashboard");
  });

  // The URL parser drops tab / CR / LF before it looks at the slashes, so each of
  // these is //evil.example by the time the router navigates.
  it("refuses a control character that the URL parser would strip into //host", () => {
    for (const next of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\t\\evil.example"]) {
      expect(new URL(next, "https://cueiq.test").host).toBe("evil.example"); // the threat is real
      expect(safeInternalPath(next)).toBe("/dashboard");
    }
  });

  it("falls back on nothing at all", () => {
    expect(safeInternalPath(null)).toBe("/dashboard");
    expect(safeInternalPath("", "")).toBe("");
  });
});
