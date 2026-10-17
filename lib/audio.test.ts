import { describe, expect, it } from "vitest";
import { unplayableAudio } from "./audio";

describe("unplayableAudio - a file the players here cannot open", () => {
  it("refuses an AIFF by its name, in any case and spelling", () => {
    for (const name of ["Master.aiff", "MASTER.AIF", "mix.aifc", "ลูป MC.Aiff"]) {
      expect(unplayableAudio({ name, type: "" }), name).toMatch(/WAV/);
    }
  });

  it("refuses an AIFF by its type when the name says nothing", () => {
    expect(unplayableAudio({ name: "export", type: "audio/aiff" })).not.toBeNull();
    expect(unplayableAudio({ name: "export", type: "audio/x-aiff" })).not.toBeNull();
  });

  it("lets everything Chromium plays through", () => {
    for (const [name, type] of [
      ["song.wav", "audio/wav"],
      ["song.mp3", "audio/mpeg"],
      ["song.m4a", "audio/mp4"],
      ["song.flac", "audio/flac"],
      ["song.ogg", "audio/ogg"],
      ["aiff-mix.wav", "audio/wav"], // "aiff" in a name is not an AIFF
    ]) {
      expect(unplayableAudio({ name, type }), name).toBeNull();
    }
  });
});
