import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// A master picked offline goes up when the queue flushes (applyAudioUploadOp). Since
// 708ef2b the upload carries its own size-scaled deadline, which desktop main really
// aborts at - an 88 MiB WAV gets ~15 min. The flush used to wrap it in a FLAT 10-min
// race of its own (2026-10-25 probe lib/_probe/misc/fa-upload-outbox-cap.test.ts):
//  - on a slow link the flush gave up at 10 min while main went on sending, so a
//    master that would have landed at 14 min never could;
//  - the op stayed queued, the lock came back, and the next flush started a SECOND
//    full PUT of the same file alongside the first.

const MiB = 1024 * 1024;

const h = vi.hoisted(() => ({
  supa: null as unknown,
  /** Replaces uploadEventAudio for one test; null = the real one. */
  upload: null as null | ((path: string, blob: Blob, type?: string) => Promise<void>),
  blob: null as unknown as Blob,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = await orig<typeof import("@/lib/audio-remote")>();
  return {
    ...real,
    uploadEventAudio: (path: string, blob: Blob, type?: string) =>
      (h.upload ?? real.uploadEventAudio)(path, blob, type),
    removeEventAudio: async () => {},
  };
});
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  getLocalSource: async () => ({ blob: h.blob, name: "take-2.wav" }),
  clearLocalSource: async () => {},
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  cacheSongBlob: async () => {},
}));
vi.mock("@/lib/audio", () => ({ detectAudioDuration: async () => 312 }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));

import { configureAudioTransport, uploadTimeoutMs } from "@/lib/audio-remote";
import { clearMgmtOutbox, enqueueMgmtOp, flushMgmtOutbox } from "./mgmt-outbox";

const SONG_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OLD_PATH = `t1/g1/${SONG_ID}/take-1.wav`;
const NEW_PATH = `t1/g1/${SONG_ID}/take-2.wav`;

// fake-indexeddb schedules on the REAL setImmediate, so a flush moves between its
// awaits in real time even while setTimeout is faked: wait (for real) until it has
// reached the point under test before moving the fake clock.
const realSetTimeout = globalThis.setTimeout;
const sleepReal = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

/** A real Blob that says it is `bytes` long - without allocating them. */
function blobOfSize(bytes: number): Blob {
  const b = new Blob(["wav"], { type: "audio/wav" });
  Object.defineProperty(b, "size", { value: bytes });
  return b;
}

let supa: SupabaseFake;

async function queueTheMaster() {
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
}

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  h.upload = null;
  h.blob = blobOfSize(3);
  await clearMgmtOutbox();
  supa.setScript({
    songs: (call) =>
      call.verb === "select"
        ? ok({ id: SONG_ID, audio_path: OLD_PATH, duration_seconds: 150, bpm: 87 })
        : ok([{ id: SONG_ID }]),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("flushMgmtOutbox — audio.upload waits as long as main may send", () => {
  it.each([88, 200])(
    "a %i MiB master that main finishes just inside its own deadline lands",
    async (mib) => {
      // IndexedDB (fake-indexeddb) schedules on setImmediate - keep that real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ url: "https://r2.example/k?sig" }),
        }))
      );
      h.blob = blobOfSize(mib * MiB);
      // desktop main: net.fetch PUT, aborted at the timeoutMs it is handed. This link
      // is slow but sound - the bytes are all in a few seconds before that deadline.
      const puts: number[] = [];
      configureAudioTransport({
        putBlob: (_url, _body, _type, timeoutMs) => {
          puts.push(timeoutMs ?? 0);
          return new Promise<void>((resolve) => setTimeout(resolve, (timeoutMs ?? 0) - 5_000));
        },
      });
      expect(uploadTimeoutMs(mib * MiB)).toBeGreaterThan(10 * 60_000);

      await queueTheMaster();
      const run = flushMgmtOutbox();
      await vi.waitFor(() => expect(puts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(uploadTimeoutMs(mib * MiB) + 60_000);
      const res = await run;

      expect(puts).toHaveLength(1);
      expect(res).toMatchObject({ flushed: 1, parked: 0, remaining: 0 });
      expect(supa.callsTo("songs", "update")[0]?.values).toMatchObject({ audio_path: NEW_PATH });
    }
  );
});

describe("flushMgmtOutbox — never two PUTs of the same file at once", () => {
  it("a flush while the last one's PUT is still running adopts it instead of starting another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // An upload that outlives the flush's own wait (e.g. a retried attempt).
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const upload = vi.fn(() => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve) => {
        release = () => {
          running--;
          resolve();
        };
      });
    });
    h.upload = upload;

    await queueTheMaster();
    const first = flushMgmtOutbox();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    // Well past any cap the flush puts on its own wait.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    // The flush gave the lock back and kept the op (a timeout is retryable)...
    expect(await first).toMatchObject({ flushed: 0, parked: 0, remaining: 1 });
    expect(upload).toHaveBeenCalledTimes(1);

    // ...and the next reconnect / "ซิงค์" press flushes again while that PUT runs.
    const second = flushMgmtOutbox();
    // it has read the song again and is at the upload step
    await vi.waitFor(() => expect(supa.callsTo("songs", "select")).toHaveLength(2));
    await sleepReal(50);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(maxRunning).toBe(1);

    // The first PUT lands: the second flush finishes the op with it.
    release();
    expect(await second).toMatchObject({ flushed: 1, parked: 0, remaining: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(supa.callsTo("songs", "update")[0]?.values).toMatchObject({ audio_path: NEW_PATH });
  });

  it("once a PUT has ended, the next flush starts a fresh one", async () => {
    // A failed attempt is over (main aborted it) - retrying it is not a duplicate.
    let calls = 0;
    h.upload = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("timeout — หมดเวลาอัปโหลดไฟล์เสียง (เครือข่ายไม่ตอบสนอง)");
    });
    await queueTheMaster();
    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 0, remaining: 1 });
    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, remaining: 0 });
    expect(calls).toBe(2);
  });
});
