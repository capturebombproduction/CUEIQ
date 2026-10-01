// getSongBlob's cancel signal must reach the actual transfer. The Library preview
// cancels a download when its player closes, switches song or the page goes away;
// if the signal stopped here, the 27–88 MB master would keep pulling (with
// retries) on the same venue link Live Mode is about to need.
import { describe, it, expect, vi } from "vitest";

const download = vi.hoisted(() => ({
  calls: [] as { path: string; signal?: AbortSignal }[],
}));
vi.mock("./audio-remote", () => ({
  downloadEventAudio: async (path: string, opts: { signal?: AbortSignal } = {}) => {
    download.calls.push({ path, signal: opts.signal });
    return new Blob(["x"], { type: "audio/wav" });
  },
}));

import { getSongBlob } from "./song-cache";

describe("getSongBlob", () => {
  // No IndexedDB in this environment → every read is a cache miss → it downloads.
  it("hands the caller's cancel signal to the download", async () => {
    const ac = new AbortController();
    await getSongBlob("t1/g1/songs/s1-aaaa.wav", { signal: ac.signal });
    expect(download.calls).toHaveLength(1);
    expect(download.calls[0].signal).toBe(ac.signal);
  });

  it("still works for a caller with no signal (the practice player)", async () => {
    download.calls = [];
    const blob = await getSongBlob("t1/g1/songs/s2-bbbb.wav");
    expect(blob.size).toBe(1);
    expect(download.calls).toEqual([{ path: "t1/g1/songs/s2-bbbb.wav", signal: undefined }]);
  });
});
