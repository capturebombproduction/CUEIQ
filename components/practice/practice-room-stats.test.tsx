// What the Training landing says about each room. The rule that matters most is
// the one with no screenshot: a read that FAILED must leave its numbers unknown,
// never 0 — "การบ้าน 0" off a dropped request tells the band there is nothing to do.
import { describe, it, expect } from "vitest";
import {
  continueRoomId,
  lastRunWhen,
  loadPracticeRoomStats,
  practiceRoomStats,
} from "./practice-room-stats";

const ROOMS = ["r1", "r2"];

describe("practiceRoomStats", () => {
  it("counts songs, open homework, and problems from the room's latest journal day", () => {
    const s = practiceRoomStats(ROOMS, {
      songs: [{ event_id: "r1" }, { event_id: "r1" }, { event_id: "r2" }, { event_id: "elsewhere" }],
      logs: [
        { event_id: "r1", category: "homework", done: false, log_date: "2026-09-28" },
        { event_id: "r1", category: "homework", done: true, log_date: "2026-09-30" },
        { event_id: "r1", category: "problem", done: false, log_date: "2026-09-28" }, // older day
        { event_id: "r1", category: "problem", done: false, log_date: "2026-09-30" },
        { event_id: "r1", category: "problem", done: false, log_date: "2026-09-30" },
        { event_id: "r1", category: "note", done: false, log_date: "2026-09-30" },
      ],
      runs: [],
    });
    expect(s.r1).toEqual({ songs: 2, homework: 1, problems: 2, lastRun: null });
    expect(s.r2).toEqual({ songs: 1, homework: 0, problems: 0, lastRun: null });
    expect(s.elsewhere).toBeUndefined();
  });

  it("keeps the newest run per room", () => {
    const s = practiceRoomStats(ROOMS, {
      songs: [],
      logs: [],
      runs: [
        { event_id: "r1", song_title: "Akai Hana", last_speed: 1, created_at: "2026-09-29T10:00:00Z" },
        { event_id: "r1", song_title: "Neon Samurai", last_speed: 0.75, created_at: "2026-09-30T06:20:00Z" },
        { event_id: "r2", song_title: "Old", last_speed: 1, created_at: "2026-09-01T06:20:00Z" },
      ],
    });
    expect(s.r1.lastRun).toEqual({ at: "2026-09-30T06:20:00Z", title: "Neon Samurai", speed: 0.75 });
    expect(continueRoomId(s)).toBe("r1");
  });

  it("a source that failed (null) leaves its fields unknown instead of 0", () => {
    const s = practiceRoomStats(ROOMS, { songs: null, logs: null, runs: null });
    expect(s.r1).toEqual({});
    expect(continueRoomId(s)).toBeNull();
  });

  it("rows missing fields (an old cache, a newer build) are skipped, not counted", () => {
    const s = practiceRoomStats(["r1"], {
      songs: [{}],
      logs: [{ event_id: "r1" }],
      runs: [{ event_id: "r1" }, { event_id: "r1", song_title: "X" }],
    });
    expect(s.r1).toEqual({ songs: 0, homework: 0, problems: 0, lastRun: null });
  });
});

describe("lastRunWhen", () => {
  it("says the Bangkok clock time, and the date only when it is not today", () => {
    // 06:20 UTC = 13:20 in Bangkok
    expect(lastRunWhen("2026-09-30T06:20:00Z", "2026-09-30")).toEqual({ day: null, time: "13:20" });
    const other = lastRunWhen("2026-09-28T06:20:00Z", "2026-09-30");
    expect(other.time).toBe("13:20");
    expect(other.day).toMatch(/28/);
  });
});

describe("loadPracticeRoomStats", () => {
  // a fake client: each table answers with `data` or an `error`
  const client = (answers: Record<string, { data?: unknown[]; error?: unknown }>) => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "order", "limit"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: answers[table]?.data ?? null, error: answers[table]?.error ?? null }).then(ok);
      return b;
    },
  });

  it("an errored read reaches the stats as unknown, the others still count", async () => {
    const s = await loadPracticeRoomStats(
      client({
        practice_songs: { data: [{ event_id: "r1" }] },
        practice_logs: { error: { message: "offline" } },
        practice_runs: { data: [] },
      }) as never,
      ["r1"]
    );
    expect(s.r1).toEqual({ songs: 1, lastRun: null });
  });

  it("no rooms, no reads", async () => {
    const from = () => {
      throw new Error("must not read");
    };
    expect(await loadPracticeRoomStats({ from } as never, [])).toEqual({});
  });
});
