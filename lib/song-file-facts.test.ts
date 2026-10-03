// lib/song-file-facts.ts - what a song's row says about its file. The questions: does a new
// file bring its own length (and only where it differs), are the old file's numbers cleared,
// is the user's bpm kept, does a length read that never answers stop waiting, and is the
// write aimed at the file that was measured (a second upload landing first is not touched).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  seconds: 312 as number | Error | "never",
  analysis: null as null | { lufs: number | null; peaks: string; beat_offset: number | null; bpm: number | null },
  analyzed: 0,
}));
vi.mock("@/lib/audio", () => ({
  detectAudioDuration: () =>
    h.seconds === "never"
      ? new Promise(() => {})
      : h.seconds instanceof Error
        ? Promise.reject(h.seconds)
        : Promise.resolve(h.seconds),
}));
vi.mock("@/lib/song-analysis-browser", () => ({
  analyzeAudioFile: async () => {
    h.analyzed++;
    return h.analysis;
  },
}));

import { fileLengthSeconds, songFilePatch, writeSongFileFacts, STALE_FILE_FACTS } from "./song-file-facts";

const FILE = new File(["x"], "take-2.wav", { type: "audio/wav" });
const MEASURED = { lufs: -8.4, peaks: "A".repeat(200), beat_offset: 0.31, bpm: 174 };

beforeEach(() => {
  h.seconds = 312;
  h.analysis = null;
  h.analyzed = 0;
});
afterEach(() => vi.useRealTimers());

describe("fileLengthSeconds", () => {
  it("is the media element's length; an unreadable file is null", async () => {
    expect(await fileLengthSeconds(FILE)).toBe(312);
    h.seconds = new Error("เปิดไฟล์เสียงไม่สำเร็จ");
    expect(await fileLengthSeconds(FILE)).toBeNull();
  });

  it("stops waiting for a metadata load that never answers", async () => {
    vi.useFakeTimers();
    h.seconds = "never";
    const p = fileLengthSeconds(FILE, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeNull();
  });
});

describe("songFilePatch", () => {
  it("a new file brings its own length - only where it differs from the row's", async () => {
    expect(await songFilePatch({ duration_seconds: 150, bpm: null }, FILE)).toEqual({ duration_seconds: 312 });
    expect(await songFilePatch({ duration_seconds: 312, bpm: null }, FILE)).toEqual({});
  });

  it("the edit dialog keeps the length it saved (length: false)", async () => {
    expect(await songFilePatch({ duration_seconds: 150, bpm: null }, FILE, { length: false })).toEqual({});
  });

  it("writes the file's loudness, waveform and first beat; fills bpm only where there is none", async () => {
    h.analysis = MEASURED;
    expect(await songFilePatch({ duration_seconds: 312, bpm: null }, FILE)).toEqual({
      lufs: -8.4,
      peaks: MEASURED.peaks,
      beat_offset: 0.31,
      bpm: 174,
    });
    // practice mode set 87 (half of what the detector heard): the user's number stays
    expect(await songFilePatch({ duration_seconds: 312, bpm: 87 }, FILE)).not.toHaveProperty("bpm");
  });

  it("analyze: false never decodes the file", async () => {
    h.analysis = MEASURED;
    expect(await songFilePatch({ duration_seconds: 150, bpm: null }, FILE, { analyze: false })).toEqual({ duration_seconds: 312 });
    expect(h.analyzed).toBe(0);
  });
});

describe("STALE_FILE_FACTS", () => {
  it("clears exactly the old file's analysis - never the user's bpm or the length", () => {
    expect(STALE_FILE_FACTS).toEqual({ lufs: null, peaks: null, beat_offset: null });
  });
});

describe("writeSongFileFacts", () => {
  function client(rows: unknown[] | null, error: unknown = null) {
    const calls: { update?: unknown; eq: [string, unknown][] } = { eq: [] };
    const chain = {
      update(p: unknown) {
        calls.update = p;
        return chain;
      },
      eq(col: string, v: unknown) {
        calls.eq.push([col, v]);
        return chain;
      },
      select: async () => ({ data: rows, error }),
    };
    const from = vi.fn(() => chain);
    return { supabase: { from } as never, calls, from };
  }
  const song = { id: "song-1", duration_seconds: 150, bpm: null };

  it("writes only while the song still points at the measured file", async () => {
    const { supabase, calls } = client([{ id: "song-1" }]);
    expect(await writeSongFileFacts(supabase, song, "t/g/song-1/take-2.wav", FILE)).toEqual({ duration_seconds: 312 });
    expect(calls.update).toEqual({ duration_seconds: 312 });
    expect(calls.eq).toEqual([
      ["id", "song-1"],
      ["audio_path", "t/g/song-1/take-2.wav"],
    ]);
  });

  it("a write that touched no row (a newer upload landed first) did not happen", async () => {
    const { supabase } = client([]);
    expect(await writeSongFileFacts(supabase, song, "t/g/song-1/take-2.wav", FILE)).toBeNull();
  });

  it("nothing to say, nothing sent", async () => {
    const { supabase, from } = client([{ id: "song-1" }]);
    h.seconds = new Error("unreadable");
    expect(await writeSongFileFacts(supabase, song, "p", FILE)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("an errored write is null, never a throw", async () => {
    const { supabase } = client(null, { message: "boom" });
    expect(await writeSongFileFacts(supabase, song, "p", FILE)).toBeNull();
  });
});
