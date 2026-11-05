import { describe, it, expect } from "vitest";
import { restoreShow, RESUME_RUNNING_MS, SNAPSHOT_ALIVE_MS, STALE_RESTORE_MS } from "./live-restore";

// 2026-11-05, hunt 13: a page gone for minutes (the PA killed or rebooted mid-song) came back
// RUNNING with the row's clock run on through the outage: Auto skipped the song that was cut,
// Manual's rescue tap played the file past its end. Between a reload and STALE_RESTORE_MS the
// show now comes back paused on its row (`cut`), and keeps its real show clock.

const NOW = 1_800_000_000_000;
const running = (itemStartedAt: number) => ({
  running: true,
  begun: true,
  startedAt: itemStartedAt - 600_000,
  itemStartedAt,
  itemElapsedAtPause: null,
  currentIndex: 3,
  mode: "auto" as const,
});

describe("restoreShow · the band between a reload and a stale show", () => {
  it("a reload's margin: one alive interval plus 15 s", () => {
    expect(RESUME_RUNNING_MS).toBe(SNAPSHOT_ALIVE_MS + 15_000);
  });

  it("back in 20 s it carries on untouched", () => {
    const s = running(NOW - 140_000);
    expect(restoreShow(s, NOW - 20_000, NOW)).toEqual({ state: s, stale: false });
  });

  it("at the margin it still carries on; past it, it is cut", () => {
    const s = running(NOW - 200_000);
    expect(restoreShow(s, NOW - RESUME_RUNNING_MS, NOW).cut).toBeUndefined();
    expect(restoreShow(s, NOW - RESUME_RUNNING_MS - 1, NOW).cut).toBe(true);
  });

  it("back in 3 min: paused on the same row where it stood when last alive, not held, real show clock", () => {
    const savedAt = NOW - 180_000;
    const s = running(savedAt - 120_000); // 2:00 into the row when the page was last alive
    const r = restoreShow(s, savedAt, NOW);
    expect(r.cut).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.state.running).toBe(false);
    expect(r.state.itemElapsedAtPause).toBe(120);
    expect(r.state.currentIndex).toBe(3);
    expect(r.state.mode).toBe("auto");
    // the slot went by: Hard Out and the run total stay on wall time
    expect(r.state.startedAt).toBe(s.startedAt);
    // the snapshot object itself is not rewritten
    expect(s.running).toBe(true);
  });

  it("a show that was not running is cut too (the caller drops a Manual cue's previous track)", () => {
    const s = { running: false, startedAt: NOW - 900_000, itemStartedAt: null, itemElapsedAtPause: 42 };
    expect(restoreShow(s, NOW - 180_000, NOW)).toEqual({ state: s, stale: false, cut: true });
  });

  it("at STALE_RESTORE_MS it is still cut; past it, held (stale) as before", () => {
    const s = running(NOW - STALE_RESTORE_MS - 60_000);
    expect(restoreShow(s, NOW - STALE_RESTORE_MS, NOW)).toMatchObject({ stale: false, cut: true });
    const r = restoreShow(s, NOW - 11 * 60 * 1000, NOW);
    expect(r.stale).toBe(true);
    expect(r.cut).toBeUndefined();
  });
});
