import { describe, it, expect } from "vitest";
import type { Song } from "@/lib/types";
import {
  orderShowsForPractice,
  overlapLead,
  setlistQueue,
  type SetlistShow,
} from "./practice-setlist";

const row = (id: string, sort: number, song_id: string | null, kind = "song", title = id) => ({
  id,
  title,
  kind,
  song_id,
  sort_order: sort,
});
const show = (id: string, event_date: string, rows = [row(`${id}-r`, 1, "s1")]): SetlistShow => ({
  id,
  name: id,
  event_date,
  setlist_items: rows,
});

describe("orderShowsForPractice", () => {
  it("puts upcoming shows first, soonest first, then the recent past, latest first", () => {
    const shows = [
      show("past-old", "2026-09-19"),
      show("next-but-one", "2026-10-12"),
      show("past-last", "2026-09-27"),
      show("next", "2026-10-05"),
      show("today", "2026-09-28"),
    ];
    expect(orderShowsForPractice(shows, "2026-09-28").map((s) => s.id)).toEqual([
      "today",
      "next",
      "next-but-one",
      "past-last",
      "past-old",
    ]);
  });

  it("with nothing upcoming, the last show leads", () => {
    const shows = [show("a", "2026-09-26"), show("b", "2026-09-27")];
    expect(orderShowsForPractice(shows, "2026-09-28")[0].id).toBe("b");
  });

  it("leaves out a show with no linked song — there is nothing to play", () => {
    const shows = [
      show("talk-only", "2026-10-01", [row("mc", 1, null, "mc")]),
      show("real", "2026-10-02"),
    ];
    expect(orderShowsForPractice(shows, "2026-09-28").map((s) => s.id)).toEqual(["real"]);
  });
});

const song = (id: string, title: string, audio: boolean): Song =>
  ({ id, title, audio_path: audio ? `${id}.wav` : null }) as Song;

describe("setlistQueue", () => {
  const songs = new Map(
    [
      song("boot", "[SYSTEM_BOOT] SE", true),
      song("neon", "Neon Lullaby", true),
      song("iam", "I Am Who I Am", true),
      song("nofile", "Overclock Strike", false),
    ].map((s) => [s.id, s])
  );
  const playable = (s: Song) => !!s.audio_path;

  it("plays the linked songs in running order and skips MC / photo rows", () => {
    const s = show("x", "2026-09-27", [
      row("r3", 3, "iam"),
      row("r1", 1, "boot"),
      row("r4", 4, null, "mc", "MC"),
      row("r2", 2, "neon"),
      row("r5", 5, null, "mc", "ถ่ายรูป"),
    ]);
    const { queue, missing } = setlistQueue(s, songs, playable);
    expect(queue.map((q) => q.song.id)).toEqual(["boot", "neon", "iam"]);
    expect(missing).toEqual([]);
  });

  it("names the songs the run will leave out instead of silently shortening the set", () => {
    const s = show("x", "2026-09-27", [
      row("r1", 1, "boot"),
      row("r2", 2, "nofile"),
      row("r3", 3, null, "song", "Out of Control"),
    ]);
    const { queue, missing } = setlistQueue(s, songs, playable);
    expect(queue.map((q) => q.song.id)).toEqual(["boot"]);
    expect(missing).toEqual(["Overclock Strike", "Out of Control"]);
  });

  // "เล่นซ้อน" — the show's own buffer_before_seconds, read as a lead.
  const bb = (r: ReturnType<typeof row>, buffer_before_seconds: number | null) => ({
    ...r,
    buffer_before_seconds,
  });

  it("carries the show's overlap onto the song it brings in early", () => {
    const s = show("x", "2026-10-03", [
      bb(row("r1", 1, "boot"), -2), // the first song has nothing before it to overlap
      bb(row("r2", 2, "neon"), -5),
      bb(row("r3", 3, "iam"), 0),
    ]);
    const { queue } = setlistQueue(s, songs, playable);
    expect(queue.map((q) => [q.song.id, q.adjacent, q.overlap])).toEqual([
      ["boot", false, 0],
      ["neon", true, 5],
      ["iam", true, 0],
    ]);
  });

  it("does not lay a song over the one before when an MC — or a song left out — sits between", () => {
    const s = show("x", "2026-10-03", [
      row("r1", 1, "boot"),
      bb(row("mc", 2, null, "mc", "MC"), -5),
      bb(row("r2", 3, "neon"), -3), // in the show this overlaps the MC
      bb(row("r3", 4, "nofile"), -3),
      bb(row("r4", 5, "iam"), -4), // …and this the song the run can't play
    ]);
    const { queue } = setlistQueue(s, songs, playable);
    expect(queue.map((q) => [q.song.id, q.adjacent, q.overlap])).toEqual([
      ["boot", false, 0],
      ["neon", false, 0],
      ["iam", false, 0],
    ]);
  });

  it("reads gaps, nothing, and out-of-range values as the builder would", () => {
    expect(overlapLead(-5)).toBe(5);
    expect(overlapLead(-2.6)).toBe(3);
    expect(overlapLead(0)).toBe(0);
    expect(overlapLead(8)).toBe(0); // a legacy wait — practice never waits
    expect(overlapLead(null)).toBe(0);
    expect(overlapLead(undefined)).toBe(0);
    expect(overlapLead(-900)).toBe(300);
  });
});
