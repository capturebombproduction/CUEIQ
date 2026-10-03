import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// A file picked offline reaches the library when the queue flushes (applyAudioUploadOp).
// Live draws the waveform on the FILE's length (songs.duration_seconds), so the flush must
// not leave the replaced take's facts behind: the write that points the song at the new
// file clears the old loudness/waveform/beat, and the new file's own length follows in
// the background, aimed at that file. No decode here - the flush can land mid-show.

const h = vi.hoisted(() => ({ supa: null as unknown, analyzed: 0 }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  uploadEventAudio: async () => {},
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  getLocalSource: async () => ({ blob: new Blob(["wav"], { type: "audio/wav" }), name: "take-2.wav" }),
  clearLocalSource: async () => {},
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  cacheSongBlob: async () => {},
}));
// the take picked offline is 5:12
vi.mock("@/lib/audio", () => ({ detectAudioDuration: async () => 312 }));
vi.mock("@/lib/song-analysis-browser", () => ({
  analyzeAudioFile: async () => {
    h.analyzed++;
    return null;
  },
}));

import { clearMgmtOutbox, enqueueMgmtOp, flushMgmtOutbox } from "./mgmt-outbox";

const SONG_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OLD_PATH = `t1/g1/${SONG_ID}/take-1.wav`;
const NEW_PATH = `t1/g1/${SONG_ID}/take-2.wav`;

let supa: SupabaseFake;

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  h.analyzed = 0;
  await clearMgmtOutbox();
  supa.setScript({
    // the guard read: the master is still the one this device replaced (a clean replace)
    songs: (call) =>
      call.verb === "select"
        ? ok({ id: SONG_ID, audio_path: OLD_PATH, duration_seconds: 150, bpm: 87 })
        : ok([{ id: SONG_ID }]),
  });
});

describe("flushMgmtOutbox — audio.upload brings the new file's facts", () => {
  it("clears the replaced take's analysis in the replace, then writes the new length aimed at the new file", async () => {
    await enqueueMgmtOp({
      kind: "audio.upload",
      id: SONG_ID,
      tenantId: "t1",
      groupId: "g1",
      path: NEW_PATH,
      fileName: "take-2.wav",
      contentType: "audio/wav",
      basePath: OLD_PATH,
      songTitle: "Neon Lullaby",
    });

    const res = await flushMgmtOutbox();
    expect(res).toMatchObject({ flushed: 1, parked: 0 });

    await vi.waitFor(() => expect(supa.callsTo("songs", "update")).toHaveLength(2));
    const [replace, length] = supa.callsTo("songs", "update");
    expect(replace.values).toEqual({
      audio_path: NEW_PATH,
      audio_name: "take-2.wav",
      audio_expires_at: null,
      lufs: null,
      peaks: null,
      beat_offset: null,
    });
    // 2:30 was the last take's; bpm 87 is the user's and is never written
    expect(length.values).toEqual({ duration_seconds: 312 });
    expect(length.eq).toEqual({ id: SONG_ID, audio_path: NEW_PATH });
    expect(h.analyzed).toBe(0);
  });
});
