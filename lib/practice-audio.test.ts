import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeAudioEngine } from "./practice-audio";

// decodeAudioData can't be cancelled, so the engine guards its buffer cache with
// a load generation: a decode that finishes AFTER load()/destroy() must be
// dropped, never cached — otherwise song B would play song A's audio. These tests
// drive that race with hand-resolved decodes (node env; minimal browser fakes).

type FakeBuffer = { name: string; duration: number };

// per-ArrayBuffer decode promises the tests resolve by hand
const decodeMap = new Map<ArrayBuffer, Promise<FakeBuffer>>();

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  decodeAudioData(arr: ArrayBuffer) {
    return decodeMap.get(arr) ?? Promise.reject(new Error("no decode planned for this blob"));
  }
}

class FakeAudio {
  preload = "";
  volume = 1;
  playbackRate = 1;
  src = "";
  paused = true;
  addEventListener() {}
  removeEventListener() {}
  load() {}
  pause() {}
  play = () => Promise.resolve();
}

/** A fake song: a blob whose decode resolves only when the test says so. */
function makeSong(name: string) {
  const arr = new ArrayBuffer(8);
  let resolveDecode!: (b: FakeBuffer) => void;
  decodeMap.set(arr, new Promise<FakeBuffer>((r) => (resolveDecode = r)));
  return {
    blob: { arrayBuffer: () => Promise.resolve(arr) } as unknown as Blob,
    finishDecode: () => resolveDecode({ name, duration: 123 }),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  decodeMap.clear();
});

describe("PracticeAudioEngine decode-generation guard", () => {
  it("caches and returns the decoded buffer for the current song", async () => {
    const engine = new PracticeAudioEngine();
    const a = makeSong("A");
    await engine.load(a.blob);
    const p = engine.getBuffer();
    a.finishDecode();
    const buf = (await p) as unknown as FakeBuffer;
    expect(buf?.name).toBe("A");
    // second call hits the cache (same object, no new decode)
    expect(await engine.getBuffer()).toBe(buf);
  });

  it("drops a decode that finishes after a newer load — stale song can't poison the cache", async () => {
    const engine = new PracticeAudioEngine();
    const a = makeSong("A");
    const b = makeSong("B");
    await engine.load(a.blob);
    const staleDecode = engine.getBuffer(); // A's decode in flight…
    await engine.load(b.blob); // …user taps song B meanwhile
    a.finishDecode(); // A resolves late
    expect(await staleDecode).toBeNull(); // stale result is discarded

    const fresh = engine.getBuffer(); // B decodes fresh, uncontaminated
    b.finishDecode();
    const buf = (await fresh) as unknown as FakeBuffer;
    expect(buf?.name).toBe("B");
    expect(await engine.getBuffer()).toBe(buf); // and B is what got cached
  });

  it("destroy() invalidates an in-flight decode", async () => {
    const engine = new PracticeAudioEngine();
    const a = makeSong("A");
    await engine.load(a.blob);
    const p = engine.getBuffer();
    engine.destroy();
    a.finishDecode();
    expect(await p).toBeNull();
  });
});
