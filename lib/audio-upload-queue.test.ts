import { describe, expect, it } from "vitest";
import {
  audioConflictReason,
  audioFlushDecision,
  type AudioUploadOp,
} from "./audio-upload-queue";

const op: Pick<AudioUploadOp, "path" | "basePath"> = {
  path: "t/g/songs/song-1-aaaa1111.wav",
  basePath: "t/g/songs/song-1-old00000.wav",
};

describe("audioFlushDecision", () => {
  it("uploads when the master is still the one we were replacing", () => {
    expect(audioFlushDecision(op, { exists: true, audioPath: op.basePath })).toBe("upload");
  });

  it("uploads a first-ever file for a song that had none", () => {
    expect(
      audioFlushDecision({ path: op.path, basePath: null }, { exists: true, audioPath: null })
    ).toBe("upload");
  });

  it("recognises its own committed work after a half-finished flush", () => {
    // PUT landed + row committed, then the app died before dequeuing: re-running
    // must not upload a second copy under a fresh key
    expect(audioFlushDecision(op, { exists: true, audioPath: op.path })).toBe("applied");
  });

  it("parks a conflict when someone else uploaded meanwhile", () => {
    expect(audioFlushDecision(op, { exists: true, audioPath: "t/g/songs/theirs.wav" })).toBe(
      "conflict"
    );
  });

  it("parks a conflict when someone else added audio to a song that had none", () => {
    expect(
      audioFlushDecision(
        { path: op.path, basePath: null },
        { exists: true, audioPath: "t/g/songs/theirs.wav" }
      )
    ).toBe("conflict");
  });

  it("parks a conflict when someone REMOVED the audio we were replacing", () => {
    // deliberate: a removal is a decision someone made, so silently restoring the
    // file this device happens to be holding is not ours to do
    expect(audioFlushDecision(op, { exists: true, audioPath: null })).toBe("conflict");
  });

  it("drops the op when the song is gone", () => {
    expect(audioFlushDecision(op, { exists: false, audioPath: null })).toBe("gone");
  });
});

describe("audioConflictReason", () => {
  it("distinguishes an overwrite from a removal", () => {
    expect(audioConflictReason({ audioPath: "x" })).toContain("ทับ");
    expect(audioConflictReason({ audioPath: null })).toContain("ลบ");
  });
});
