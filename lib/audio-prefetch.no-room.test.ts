// 2026-10-30, hunt 12: a prepare on a full disk swallowed the failure. The result now says a file
// failed for want of room, so the two callers can say so instead of leaving a bar that ran to its
// end over a card that still reads "not ready".
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ saveError: null as unknown }));
vi.mock("./audio-remote", () => ({ downloadEventAudio: vi.fn(async () => new Blob(["x"])) }));
vi.mock("./song-cache", () => ({
  getCachedSongBlob: vi.fn(async () => null),
  cacheSongBlob: vi.fn(async () => {}),
}));
vi.mock("./audio-store", () => ({
  listCachedEntries: vi.fn(async () => ({})),
  deleteAudio: vi.fn(async () => {}),
  saveAudio: vi.fn(async () => {
    if (h.saveError) throw h.saveError;
  }),
}));

import { prefetchEventAudio, prefetchFailureText } from "./audio-prefetch";

const targets = [{ itemId: "a", path: "t/g/a.wav", name: "a.wav" }];

describe("prefetchEventAudio · a file that found no room", () => {
  it("is told apart from any other failure", async () => {
    h.saveError = new DOMException("full", "QuotaExceededError");
    const res = await prefetchEventAudio("ev", targets);
    expect(res).toMatchObject({ failed: 1, noRoom: true });
    expect(prefetchFailureText(res.failed, res.noRoom).description).toContain("พื้นที่ในเครื่องเต็ม");
  });
  it("any other failure does not claim the disk is full", async () => {
    h.saveError = new Error("network");
    const res = await prefetchEventAudio("ev", targets);
    expect(res).toMatchObject({ failed: 1, noRoom: false });
    expect(prefetchFailureText(res.failed, res.noRoom).description).not.toContain("เต็ม");
  });
});
