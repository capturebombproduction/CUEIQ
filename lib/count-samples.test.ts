import { describe, expect, it, vi } from "vitest";
import {
  COUNT_SAMPLE_COUNT,
  countSampleUrl,
  countSetIsComplete,
  countVoiceNote,
  decodeDataUri,
  loadCountSamples,
} from "./count-samples";

// The spoken 1–8 count. These tests exist because the desktop build shipped the
// metronome WITHOUT these samples for months and said nothing: the loader's
// failure was swallowed and the mode pill kept reading "เสียงสาวญี่ปุ่น" while a
// laggy TTS voice counted off the beat. So pin the two things that made that
// possible — all-or-nothing loading, and a label that tells the truth.

function res(body: ArrayBuffer, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => body,
  } as unknown as Response;
}

const oneByte = () => new Uint8Array([1]).buffer;

describe("countSampleUrl", () => {
  it("is root-absolute so it resolves the same from every practice route", () => {
    expect(countSampleUrl(1)).toBe("/sounds/count/1.mp3");
    expect(countSampleUrl(8)).toBe("/sounds/count/8.mp3");
  });
});

describe("loadCountSamples", () => {
  it("asks for all eight, in order", async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (u: string) => {
      seen.push(u);
      return res(oneByte());
    });
    const out = await loadCountSamples(fake as unknown as typeof fetch);
    expect(out).toHaveLength(COUNT_SAMPLE_COUNT);
    expect(seen.sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `/sounds/count/${i + 1}.mp3`).sort()
    );
  });

  it("rejects the WHOLE load when one sample 404s (no 7-of-8 stutter)", async () => {
    const fake = async (u: string) =>
      u.endsWith("5.mp3") ? res(new ArrayBuffer(0), false, 404) : res(oneByte());
    await expect(loadCountSamples(fake as unknown as typeof fetch)).rejects.toThrow("404");
  });

  it("rejects when a sample comes back empty (decodes to silence otherwise)", async () => {
    const fake = async (u: string) =>
      u.endsWith("3.mp3") ? res(new ArrayBuffer(0)) : res(oneByte());
    await expect(loadCountSamples(fake as unknown as typeof fetch)).rejects.toThrow(/ว่างเปล่า/);
  });

  it("propagates a network rejection instead of resolving short", async () => {
    const fake = async () => {
      throw new Error("offline");
    };
    await expect(loadCountSamples(fake as unknown as typeof fetch)).rejects.toThrow("offline");
  });
});

describe("decodeDataUri", () => {
  it("round-trips base64 bytes", () => {
    const buf = decodeDataUri("data:audio/mpeg;base64,SUQz"); // "ID3"
    expect(Array.from(new Uint8Array(buf))).toEqual([0x49, 0x44, 0x33]);
  });

  it("throws on a non-data URI (a build that failed to inline)", () => {
    expect(() => decodeDataUri("/assets/1-abc123.mp3")).toThrow();
  });

  it("throws on a data URI that is not base64", () => {
    expect(() => decodeDataUri("data:text/plain,hello")).toThrow();
  });
});

// The load path was already all-or-nothing; the DECODE path was not, and stored
// a half-decoded set into the scheduler's per-beat lookup. That is the mixed
// count — beats 1–2 in the recorded voice, 3–8 in the machine's TTS — which the
// amber notice does not even describe (it says the device voice is used INSTEAD,
// not as well). Pin the rule on this side too.
describe("countSetIsComplete", () => {
  const buf = () => ({}); // stands in for a decoded AudioBuffer

  it("accepts a full set", () => {
    expect(countSetIsComplete(Array.from({ length: COUNT_SAMPLE_COUNT }, buf))).toBe(true);
  });

  it("rejects a set with ONE hole — 7-of-8 is the forbidden state, not a near miss", () => {
    const decoded: unknown[] = Array.from({ length: COUNT_SAMPLE_COUNT }, buf);
    decoded[7] = null;
    expect(countSetIsComplete(decoded)).toBe(false);
  });

  it("rejects the shape a torn-down context leaves behind (decoded 2, rejected 6)", () => {
    const decoded = [buf(), buf(), null, null, null, null, null, null];
    expect(countSetIsComplete(decoded)).toBe(false);
  });

  it("rejects a SHORT set — [].every(Boolean) is true, so length must be checked", () => {
    // A failed decode is not a clean pass. Without the length check an empty or
    // truncated array reports "ready" and the pill promises a voice that never
    // decoded.
    expect(countSetIsComplete([])).toBe(false);
    expect(countSetIsComplete(Array.from({ length: COUNT_SAMPLE_COUNT - 1 }, buf))).toBe(false);
  });

  it("rejects a set padded with undefined holes (sparse array from index writes)", () => {
    const sparse: unknown[] = [];
    sparse[COUNT_SAMPLE_COUNT - 1] = buf(); // length 8, seven holes
    expect(countSetIsComplete(sparse)).toBe(false);
  });
});

describe("countVoiceNote", () => {
  it("only promises the cute voice when the samples actually loaded", () => {
    expect(countVoiceNote("ready", true)).toBe("เสียงสาวญี่ปุ่น");
    expect(countVoiceNote("loading", true)).not.toContain("เสียงสาวญี่ปุ่น");
    expect(countVoiceNote("unavailable", true)).not.toContain("เสียงสาวญี่ปุ่น");
    expect(countVoiceNote("unavailable", false)).not.toContain("เสียงสาวญี่ปุ่น");
  });

  it("names the fallback the operator will actually hear", () => {
    expect(countVoiceNote("unavailable", true)).toContain("เสียงอ่านของเครื่อง");
    expect(countVoiceNote("unavailable", false)).toContain("เสียงคลิก");
  });
});
