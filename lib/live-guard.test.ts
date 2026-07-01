import { afterEach, describe, expect, it } from "vitest";
import { isLiveShowActive, setLiveShowActive } from "./live-guard";

// Reset the module flag between tests so state can't leak.
afterEach(() => setLiveShowActive(false));

describe("live-guard flag", () => {
  it("defaults to inactive", () => {
    expect(isLiveShowActive()).toBe(false);
  });
  it("reflects the last set value (Live Mode arms it, teardown clears it)", () => {
    setLiveShowActive(true);
    expect(isLiveShowActive()).toBe(true);
    setLiveShowActive(false);
    expect(isLiveShowActive()).toBe(false);
  });
});
