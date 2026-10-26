// Hunt 3 (2026-10-27), songs-1c: venue Wi-Fi joined but dead, laptop woke with an expired token.
// presign()'s auth hop (getSession -> refresh) never answers; raceAbort gives up after 20 s
// with a THAI-ONLY message. withRetry tries 3 times and throws that message. The desktop's
// tryQueueAudioUpload classifies with isQueueableWriteError(message, onLine=true), which only
// reads ASCII - so the picked take is NOT queued (UPLOAD_TIMEOUT_MESSAGE got an ASCII
// "timeout" for exactly this reason; this sibling message did not).
import { describe, it, expect, vi, afterEach } from "vitest";
import { configureAudioTransport, uploadEventAudio } from "@/lib/audio-remote";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";

afterEach(() => {
  vi.useRealTimers();
});

describe("upload whose presign auth hop black-holes", () => {
  it("fails with an error the queue classifier reads as transient", async () => {
    vi.useFakeTimers();
    configureAudioTransport({ getAuthHeaders: () => new Promise<Record<string, string>>(() => {}) });
    let err: unknown = null;
    const p = uploadEventAudio("t1/g1/songs/s1-abc.wav", new Blob(["x"]), "audio/wav").catch((e) => {
      err = e;
    });
    await vi.advanceTimersByTimeAsync(3 * 20_000 + 5_000);
    await p;
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { status?: number };
    expect(isQueueableWriteError(e.message, true, e.status ?? null)).toBe(true);
  });
});
