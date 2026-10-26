import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { audioConflictReason } from "@/lib/audio-upload-queue";

// 2026-10-26 final hunt (ported from desktop/src/_probe/songs/audio-flush-overwrites-
// newer-master.test.tsx). The queued offline upload's guard is a check-then-act
// across a multi-minute PUT: applyAudioUploadOp read the song, decided "upload"
// because the server still pointed at op.basePath, PUT the 27-88 MB master (minutes
// on venue wifi), then wrote audio_path = op.path with ONLY .eq("id", …). A newer
// master uploaded DURING that PUT (another device, or this one's own
// "เลือกไฟล์ใหม่แทนไฟล์ที่รออัปโหลด") was silently overwritten by the older take.
// The write is now a compare-and-swap on the master the guard saw; a lost swap parks
// the op for a human with the local source intact. "ใช้ของฉัน" still overwrites.

const SONG_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE = `t1/g1/songs/${SONG_ID}-aaaaaaaa.wav`; // the master the desktop replaced offline
const QUEUED = `t1/g1/songs/${SONG_ID}-bbbbbbbb.wav`; // the take picked offline
const NEWER = `t1/g1/songs/${SONG_ID}-cccccccc.mp3`; // uploaded elsewhere while our PUT ran

const h = vi.hoisted(() => ({
  supa: null as unknown,
  server: "" as string | null,
  exists: true,
  /** the server refuses the row write (RLS) without an error */
  refuse: false,
  onPut: () => {},
  puts: 0,
  cleared: [] as string[],
  removed: [] as string[],
  cached: [] as string[],
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  // the long PUT: while it runs, the other device's replace lands on the server
  uploadEventAudio: async () => {
    h.puts++;
    h.onPut();
  },
  removeEventAudio: async (path: string) => {
    h.removed.push(path);
  },
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  getLocalSource: async () => ({ blob: new Blob(["wav"], { type: "audio/wav" }), name: "venue-take.wav" }),
  clearLocalSource: async (id: string) => {
    h.cleared.push(id);
  },
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  cacheSongBlob: async (path: string) => {
    h.cached.push(path);
  },
}));
vi.mock("@/lib/audio", () => ({ detectAudioDuration: async () => 200 }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));

import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtCount,
  resolveMgmtConflict,
} from "./mgmt-outbox";

let supa: SupabaseFake;

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  h.server = BASE;
  h.exists = true;
  h.refuse = false;
  h.onPut = () => {
    h.server = NEWER;
  };
  h.puts = 0;
  h.cleared = [];
  h.removed = [];
  h.cached = [];
  await clearMgmtOutbox();
  // A tiny server: songs.audio_path is one cell. An update honours an audio_path
  // filter if the client sends one (compare-and-swap); without one it simply lands.
  supa.setScript({
    songs: (call) => {
      if (call.verb === "select") {
        if (!h.exists) return ok([]);
        return ok({ id: SONG_ID, audio_path: h.server, duration_seconds: 150, bpm: null, copyright_status: "cleared" });
      }
      if (call.verb === "update") {
        const values = call.values as Record<string, unknown>;
        if (!("audio_path" in values)) return ok([{ id: SONG_ID }]);
        if (!h.exists || h.refuse) return ok([]);
        const cas = call.filters.find((f) => f.column === "audio_path");
        if (cas) {
          const matches = cas.op === "is" ? h.server === null : cas.value === h.server;
          if (!matches) return ok([]);
        }
        h.server = values.audio_path as string;
        return ok([{ id: SONG_ID, copyright_status: "pending" }]);
      }
      return ok([]);
    },
  });
});

function audioWrites() {
  return supa
    .callsTo("songs", "update")
    .filter((c) => "audio_path" in (c.values as Record<string, unknown>));
}

async function queue(basePath: string | null) {
  await enqueueMgmtOp({
    kind: "audio.upload",
    id: SONG_ID,
    tenantId: "t1",
    groupId: "g1",
    path: QUEUED,
    fileName: "venue-take.wav",
    contentType: "audio/wav",
    basePath,
    songTitle: "Neon Lullaby",
  });
}

describe("flushMgmtOutbox — a master replaced during the queued PUT survives", () => {
  it("does not overwrite the newer master uploaded while the queued file was uploading", async () => {
    await queue(BASE);

    const res = await flushMgmtOutbox();

    expect(h.puts).toBe(1);
    // the newer master is still the song's file
    expect(h.server).toBe(NEWER);
    // ...and the venue take is parked for a human, in the words the panel uses
    expect(res).toMatchObject({ flushed: 0, parked: 1 });
    const parked = await listMgmtConflicts();
    expect(parked).toHaveLength(1);
    expect(parked[0].rec.reason).toBe(audioConflictReason({ audioPath: NEWER }));
    expect(await pendingMgmtCount()).toBe(0);
    // the take stays playable here and the new master is not swept or re-cached
    expect(h.cleared).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.cached).toEqual([]);
  });

  it("sends the write as a compare-and-swap on the master the guard saw", async () => {
    h.onPut = () => {}; // nobody races: a clean replace
    await queue(BASE);

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect(h.server).toBe(QUEUED);
    const [write] = audioWrites();
    expect(write.filters).toContainEqual(expect.objectContaining({ op: "eq", column: "audio_path", value: BASE }));
    // the tail still runs on a landed swap: cache, sweep the replaced file, drop the override
    expect(h.cached).toEqual([QUEUED]);
    expect(h.removed).toEqual([BASE]);
    expect(h.cleared).toEqual([SONG_ID]);
  });

  it("a first upload onto a song with no audio swaps on IS NULL, and parks if someone beat it", async () => {
    h.server = null;
    await queue(null);

    await flushMgmtOutbox();

    expect(h.server).toBe(NEWER);
    const [write] = audioWrites();
    expect(write.filters).toContainEqual(expect.objectContaining({ op: "is", column: "audio_path", value: null }));
    const parked = await listMgmtConflicts();
    expect(parked.map((p) => p.rec.reason)).toEqual([audioConflictReason({ audioPath: NEWER })]);
    expect(h.cleared).toEqual([]);
  });

  it("a song deleted during the PUT parks as deleted", async () => {
    h.onPut = () => {
      h.exists = false;
    };
    await queue(BASE);

    await flushMgmtOutbox();

    const parked = await listMgmtConflicts();
    expect(parked.map((p) => p.rec.reason)).toEqual(["เพลงนี้ถูกลบไปแล้วบนออนไลน์ — อัปไฟล์ขึ้นไม่ได้"]);
    expect(h.cleared).toEqual([]);
  });

  it("a refused write on an unchanged master is not reported as someone else's upload", async () => {
    h.onPut = () => {};
    h.refuse = true;
    await queue(BASE);

    await flushMgmtOutbox();

    expect(h.server).toBe(BASE);
    const parked = await listMgmtConflicts();
    expect(parked).toHaveLength(1);
    expect(parked[0].rec.reason).not.toBe(audioConflictReason({ audioPath: BASE }));
    expect(parked[0].rec.reason).toContain("ไม่สำเร็จ");
    expect(h.cleared).toEqual([]);
  });

  it("'ใช้ของฉัน' on the parked take still overwrites the newer master", async () => {
    await queue(BASE);
    await flushMgmtOutbox();
    const [{ key }] = await listMgmtConflicts();
    h.onPut = () => {};

    const res = await resolveMgmtConflict(key, "mine");

    expect(res).toEqual({ ok: true });
    expect(h.server).toBe(QUEUED);
    const writes = audioWrites();
    const forced = writes[writes.length - 1];
    expect(forced.filters.some((f) => f.column === "audio_path")).toBe(false);
    expect(await listMgmtConflicts()).toEqual([]);
    expect(h.cleared).toEqual([SONG_ID]);
  });
});
