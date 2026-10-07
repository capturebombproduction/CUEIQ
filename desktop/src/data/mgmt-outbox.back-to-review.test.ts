import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// 0047 (พี่ 2026-10-07): a reviewed song given a new file goes back to "รอตรวจ" on the
// server. A file picked OFFLINE reaches the library when the desktop queue flushes, and
// that flush tells the admins the same way the library does online - once, and only
// when the song really went back.

const h = vi.hoisted(() => ({ supa: null as unknown, analyzed: 0, notify: vi.fn(), before: "cleared", after: "pending" }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
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
  h.notify.mockClear();
  h.before = "cleared";
  h.after = "pending";
  await clearMgmtOutbox();
  supa.setScript({
    // the guard read: the master is still the one this device replaced (a clean replace)
    songs: (call) =>
      call.verb === "select"
        ? ok({ id: SONG_ID, audio_path: OLD_PATH, duration_seconds: 150, bpm: 87, copyright_status: h.before })
        : ok([{ id: SONG_ID, copyright_status: h.after }]),
  });
});

const op = {
  kind: "audio.upload" as const,
  id: SONG_ID,
  tenantId: "t1",
  groupId: "g1",
  path: NEW_PATH,
  fileName: "take-2.wav",
  contentType: "audio/wav",
  basePath: OLD_PATH,
  songTitle: "Neon Lullaby",
};

describe("flushMgmtOutbox — audio.upload on a reviewed song", () => {
  it("a cleared song sent back to รอตรวจ: the admins are told", async () => {
    await enqueueMgmtOp(op);
    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, parked: 0 });
    expect(h.notify).toHaveBeenCalledWith("song_resubmitted", { songId: SONG_ID });
  });
  it("a song that was already pending: nothing new to tell", async () => {
    h.before = "pending";
    await enqueueMgmtOp(op);
    await flushMgmtOutbox();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("the server kept the verdict (an approver's own file): nothing to tell", async () => {
    h.after = "cleared";
    await enqueueMgmtOp(op);
    await flushMgmtOutbox();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
