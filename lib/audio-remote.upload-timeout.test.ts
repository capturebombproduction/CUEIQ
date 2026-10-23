// ---------------------------------------------------------------------------
// AN UPLOAD ALWAYS ENDS.
//
// uploadEventAudio's PUT had no bound at all. On a black-holed venue AP it never
// settled, so the Library's file button stayed disabled until a reload, and on the
// desktop the catch that keeps the bytes and queues them for later (lib/mgmt-write.ts
// tryQueueAudioUpload, ⭐#1 step 6) never ran. Now each attempt has a deadline scaled
// to the file's size, hitting it is terminal (no second and third full wait), and the
// desktop hands the deadline to the main process so the transfer is really cancelled.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";

const MB = 1024 * 1024;

/** presign answers at once; every PUT hangs until its signal aborts (a black hole). */
function blackHoleFetch() {
  const puts: RequestInit[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/api/audio/presign")) {
      return { ok: true, status: 200, json: async () => ({ url: "https://bucket.r2.cloudflarestorage.com/k?sig" }) };
    }
    puts.push(init ?? {});
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" }))
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { puts };
}

async function load() {
  vi.resetModules();
  return import("./audio-remote");
}

/** Start the upload and report whether (and how) it has settled. */
function track(p: Promise<void>) {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  p.then(
    () => (state.settled = true),
    (e) => {
      state.settled = true;
      state.error = e;
    }
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("uploadEventAudio: the PUT is bounded", () => {
  it("the deadline scales with the file (2 min floor, ~100 kB/s beyond it)", async () => {
    const { uploadTimeoutMs } = await load();
    expect(uploadTimeoutMs(0)).toBe(120_000);
    expect(uploadTimeoutMs(8 * MB)).toBe(120_000);
    // an 88 MB master gets the same ~15 minutes a download of it does
    expect(uploadTimeoutMs(88 * MB)).toBeGreaterThan(14 * 60_000);
    expect(uploadTimeoutMs(88 * MB)).toBeLessThan(16 * 60_000);
  });

  it("browser: a black-holed PUT fails once its deadline passes, and is not retried", async () => {
    const { puts } = blackHoleFetch();
    const { uploadEventAudio } = await load();
    const up = track(uploadEventAudio("t/g/s/a.wav", new Blob([new Uint8Array(1024)]), "audio/wav"));

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(up.settled).toBe(true);
    expect(String((up.error as Error)?.message)).toMatch(/timeout/);
    expect(puts).toHaveLength(1); // one deadline, not three
    // ... and it reads as transient, so the desktop keeps the bytes and queues them
    expect(isQueueableWriteError((up.error as Error).message, true)).toBe(true);
  });

  it("desktop: main is handed the deadline; a main that never answers is given up on", async () => {
    blackHoleFetch(); // presign only — the bytes go through putBlob
    const { uploadEventAudio, configureAudioTransport } = await load();
    const putBlob = vi.fn(() => new Promise<void>(() => {}));
    configureAudioTransport({ putBlob });
    const up = track(uploadEventAudio("t/g/s/a.wav", new Blob([new Uint8Array(1024)]), "audio/wav"));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(putBlob).toHaveBeenCalledTimes(1);
    expect((putBlob.mock.calls[0] as unknown[])[3]).toBe(120_000);
    expect(up.settled).toBe(false); // still inside the deadline

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(up.settled).toBe(true);
    expect(String((up.error as Error)?.message)).toMatch(/timeout/);
    expect(putBlob).toHaveBeenCalledTimes(1);
  });

  it("desktop: main's own abort is terminal too (no second full transfer)", async () => {
    blackHoleFetch();
    const { uploadEventAudio, configureAudioTransport } = await load();
    const putBlob = vi.fn(async () => {
      throw new Error("Error invoking remote method 'cueiq:put-audio': Error: upload timed out after 120 s");
    });
    configureAudioTransport({ putBlob });
    const up = track(uploadEventAudio("t/g/s/a.wav", new Blob([new Uint8Array(1024)]), "audio/wav"));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(up.settled).toBe(true);
    expect(String((up.error as Error)?.message)).toMatch(/timeout/);
    expect(putBlob).toHaveBeenCalledTimes(1);
  });

  it("an ordinary failed PUT is still retried (transient R2 hiccup)", async () => {
    blackHoleFetch();
    const { uploadEventAudio, configureAudioTransport } = await load();
    let n = 0;
    const putBlob = vi.fn(async () => {
      if (++n < 3) throw new Error("upload failed (503)");
    });
    configureAudioTransport({ putBlob });
    const up = track(uploadEventAudio("t/g/s/a.wav", new Blob([new Uint8Array(1024)]), "audio/wav"));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(up.settled).toBe(true);
    expect(up.error).toBeUndefined();
    expect(putBlob).toHaveBeenCalledTimes(3);
  });
});
