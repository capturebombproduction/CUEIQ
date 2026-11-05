import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/lib/with-timeout";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands back the value when it lands in time, and leaves no timer behind", async () => {
    const res = withTimeout(Promise.resolve("fresh"), 8000);
    await expect(res).resolves.toBe("fresh");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves null once the budget runs out, and drops the late value", async () => {
    let answer!: (v: string) => void;
    const slow = new Promise<string>((r) => (answer = r));
    const res = withTimeout(slow, 2000);
    vi.advanceTimersByTime(2000);
    await expect(res).resolves.toBeNull();
    answer("late");
    await expect(res).resolves.toBeNull();
  });

  it("passes a rejection through when it lands in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 8000)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a LATE rejection, so it never surfaces as unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let fail!: (e: Error) => void;
      const slow = new Promise<string>((_, r) => (fail = r));
      const res = withTimeout(slow, 2000);
      vi.advanceTimersByTime(2000);
      await expect(res).resolves.toBeNull();
      fail(new Error("late boom"));
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("accepts a postgrest-style thenable, not only a Promise", async () => {
    const thenable: PromiseLike<{ data: number[] }> = {
      then: (ok, bad) => Promise.resolve({ data: [1] }).then(ok, bad),
    };
    await expect(withTimeout(thenable, 8000)).resolves.toEqual({ data: [1] });
  });
});
