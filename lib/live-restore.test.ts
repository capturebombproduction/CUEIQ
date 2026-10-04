import { describe, it, expect } from "vitest";
import { restoreShow, STALE_RESTORE_MS } from "./live-restore";

const NOW = 1_800_000_000_000;
const running = (itemStartedAt: number) => ({
  running: true,
  begun: true,
  startedAt: itemStartedAt - 60_000,
  itemStartedAt,
  itemElapsedAtPause: null,
  currentIndex: 2,
  mode: "auto" as const,
});

describe("restoreShow", () => {
  it("a page back within the window carries its show on, untouched", () => {
    const s = running(NOW - 90_000);
    const r = restoreShow(s, NOW - 60_000, NOW);
    expect(r).toEqual({ state: s, stale: false });
  });

  it("exactly at the window it still carries on", () => {
    const s = running(NOW - STALE_RESTORE_MS - 5_000);
    expect(restoreShow(s, NOW - STALE_RESTORE_MS, NOW).stale).toBe(false);
  });

  it("a page gone longer comes back paused where it stood when it was last alive", () => {
    const savedAt = NOW - 3 * 60 * 60 * 1000; // a rehearsal closed three hours ago
    const s = running(savedAt - 75_000); // 1:15 into the row when it closed
    const r = restoreShow(s, savedAt, NOW);
    expect(r.stale).toBe(true);
    expect(r.state.running).toBe(false);
    expect(r.state.itemElapsedAtPause).toBe(75);
    // the same row, the same show - only the motion stops
    expect(r.state.currentIndex).toBe(2);
    expect(r.state.startedAt).toBe(s.startedAt);
    expect(r.state.mode).toBe("auto");
    // and the snapshot object itself is not rewritten
    expect(s.running).toBe(true);
  });

  it("a show that was already paused keeps its own position, and still says stale", () => {
    const s = { running: false, itemStartedAt: null, itemElapsedAtPause: 42 };
    const r = restoreShow(s, NOW - STALE_RESTORE_MS - 1, NOW);
    // stale even though nothing ran: a Manual cue keeps the previous track sounding
    // with running:false, and the caller drops it on this flag
    expect(r).toEqual({ state: s, stale: true });
  });

  it("never a negative position (a clock that moved back)", () => {
    const savedAt = NOW - STALE_RESTORE_MS - 1;
    const r = restoreShow(running(savedAt + 5_000), savedAt, NOW);
    expect(r.state.itemElapsedAtPause).toBe(0);
  });
});
