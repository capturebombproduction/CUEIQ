import { describe, it, expect } from "vitest";
import {
  heldFileIsAnotherSongs,
  resolveAudioTargets,
  resolveLocalOnlyCandidates,
  type SongAudioMap,
} from "./audio-targets";

// The rule these two share: a library-linked row plays its SONG's file, and only an
// UNLINKED legacy row falls back to the path still sitting on the row itself. It has
// been inverted by hand once already, which is why it is pinned here.
const songAudio: SongAudioMap = {
  "song-with-master": { path: "t/g/songs/aaa-1.wav", name: "master.wav" },
  "song-no-master": { path: null, name: null },
};

const items = [
  { id: "i1", song_id: "song-with-master", audio_path: "stale/row/path.wav", title: "มีต้นฉบับ" },
  { id: "i2", song_id: "song-no-master", audio_path: null, title: "รออัปโหลด" },
  { id: "i3", song_id: null, audio_path: "legacy/unlinked.wav", audio_name: "legacy.wav", title: "เก่า" },
  { id: "i4", song_id: null, audio_path: null, title: "MC" },
  { id: "i5", song_id: "song-not-in-map", audio_path: null, title: "เพลงที่ยังไม่โหลด" },
];

describe("resolveAudioTargets", () => {
  it("prefers the song's master over a path the row still carries", () => {
    const t = resolveAudioTargets(items, songAudio);
    expect(t.find((x) => x.itemId === "i1")?.path).toBe("t/g/songs/aaa-1.wav");
  });

  it("keeps an unlinked legacy row on its own path", () => {
    const t = resolveAudioTargets(items, songAudio);
    expect(t.find((x) => x.itemId === "i3")?.path).toBe("legacy/unlinked.wav");
  });

  it("drops every row with no downloadable file", () => {
    const ids = resolveAudioTargets(items, songAudio).map((x) => x.itemId);
    expect(ids).toEqual(["i1", "i3"]);
  });
});

describe("resolveLocalOnlyCandidates", () => {
  it("returns exactly the linked rows whose song has no master", () => {
    const c = resolveLocalOnlyCandidates(items, songAudio);
    expect(c.map((x) => x.itemId)).toEqual(["i2", "i5"]);
  });

  it("carries the songId, because that is what local bytes are keyed by", () => {
    const c = resolveLocalOnlyCandidates(items, songAudio);
    expect(c.find((x) => x.itemId === "i2")?.songId).toBe("song-no-master");
  });

  it("never claims an MC row or an unlinked legacy row", () => {
    const ids = resolveLocalOnlyCandidates(items, songAudio).map((x) => x.itemId);
    expect(ids).not.toContain("i3"); // has its own file
    expect(ids).not.toContain("i4"); // no song, no file — nothing to look up
  });

  it("never overlaps with resolveAudioTargets — every row is in exactly one bucket", () => {
    const targets = new Set(resolveAudioTargets(items, songAudio).map((x) => x.itemId));
    const local = new Set(resolveLocalOnlyCandidates(items, songAudio).map((x) => x.itemId));
    for (const id of targets) expect(local.has(id)).toBe(false);
  });

  it("falls back to a generic name when the row has no title", () => {
    const c = resolveLocalOnlyCandidates(
      [{ id: "x", song_id: "song-no-master", title: "   " }],
      songAudio
    );
    expect(c[0].name).toBe("เพลง");
  });
});

// A row swapped to another song ("เปลี่ยน") while a device held the old one's bytes.
describe("heldFileIsAnotherSongs", () => {
  const songAudio = {
    songA: { path: "t/g/a.mp3", name: "A" },
    songB: { path: null, name: null }, // just added, no master yet
  };
  it("is true when the held file is another song's current master", () => {
    expect(heldFileIsAnotherSongs("t/g/a.mp3", "songB", songAudio)).toBe(true);
  });
  it("is false for the row's own song — that is a version question, not a swap", () => {
    expect(heldFileIsAnotherSongs("t/g/a.mp3", "songA", songAudio)).toBe(false);
  });
  it("is false for a path the library does not know — keep the bytes (offline cache, deleted master)", () => {
    expect(heldFileIsAnotherSongs("t/g/old.mp3", "songB", songAudio)).toBe(false);
    expect(heldFileIsAnotherSongs("t/g/a.mp3", "songB", {})).toBe(false);
  });
  it("is false with nothing held, or a device-local record with no path", () => {
    expect(heldFileIsAnotherSongs(null, "songB", songAudio)).toBe(false);
    expect(heldFileIsAnotherSongs(undefined, "songB", songAudio)).toBe(false);
  });
});
