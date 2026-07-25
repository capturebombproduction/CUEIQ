import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeAudioEngine } from "./practice-audio";

// decodeAudioData can't be cancelled, so the engine guards its buffer cache with
// a load generation: a decode that finishes AFTER load()/destroy() must be
// dropped, never cached — otherwise song B would play song A's audio. These tests
// drive that race with hand-resolved decodes (node env; minimal browser fakes).

type FakeBuffer = { name: string; duration: number };

// per-ArrayBuffer decodes the tests settle by hand; `started` fires when the
// engine actually calls decodeAudioData, so a test can line a race up against the
// decode being genuinely in flight
type PlannedDecode = { decode: Promise<FakeBuffer>; started: () => void };
const decodeMap = new Map<ArrayBuffer, PlannedDecode>();

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  decodeAudioData(arr: ArrayBuffer) {
    const planned = decodeMap.get(arr);
    if (!planned) return Promise.reject(new Error("no decode planned for this blob"));
    planned.started();
    return planned.decode;
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

/** A fake song: a blob whose decode settles only when the test says so. */
function makeSong(name: string) {
  const arr = new ArrayBuffer(8);
  let resolveDecode!: (b: FakeBuffer) => void;
  let rejectDecode!: (e: unknown) => void;
  let notifyStarted!: () => void;
  const decodeStarted = new Promise<void>((r) => (notifyStarted = r));
  decodeMap.set(arr, {
    decode: new Promise<FakeBuffer>((res, rej) => {
      resolveDecode = res;
      rejectDecode = rej;
    }),
    started: notifyStarted,
  });
  return {
    blob: { arrayBuffer: () => Promise.resolve(arr) } as unknown as Blob,
    decodeStarted, // await this before racing, or the engine hasn't decoded yet
    finishDecode: () => resolveDecode({ name, duration: 123 }),
    // decodeAudioData rejects on masters Web Audio can't handle — and also when
    // destroy() closes the context out from under an in-flight decode
    failDecode: () => rejectDecode(new Error(`cannot decode ${name}`)),
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

// The slow-down decode can also FAIL. When it fails for the song on screen we must
// drop back to 1× native and say so; when it fails late — after the user moved on,
// or left the room — that same handling would hijack a song (or a page) it no
// longer owns, so it has to stay a no-op.
describe("PracticeAudioEngine stretch-decode failure", () => {
  it("falls back to 1× and tells the player when the CURRENT song can't decode", async () => {
    const engine = new PracticeAudioEngine();
    const failed = vi.fn();
    engine.onStretchFailed = failed;
    engine.setTempo(0.75); // the user is practising slowed down
    const a = makeSong("A");
    const loading = engine.load(a.blob);
    await a.decodeStarted;
    a.failDecode();
    await loading;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(engine.tempo).toBe(1); // speed buttons must follow the real backend
  });

  it("a stale decode failure doesn't hijack the song that took over", async () => {
    const engine = new PracticeAudioEngine();
    const failed = vi.fn();
    engine.onStretchFailed = failed;
    engine.setTempo(0.75);
    const a = makeSong("A");
    const b = makeSong("B");
    const loadingA = engine.load(a.blob);
    await a.decodeStarted; // A's decode really is in flight…
    void engine.load(b.blob); // …user taps song B a second later
    a.failDecode(); // A rejects late, while B is on screen
    await loadingA;
    expect(failed).not.toHaveBeenCalled(); // no red toast over song B
    expect(engine.tempo).toBe(0.75); // and B's speed is left alone
  });

  it("a decode that fails after destroy() touches nothing", async () => {
    const engine = new PracticeAudioEngine();
    const failed = vi.fn();
    engine.onStretchFailed = failed;
    engine.setTempo(0.5);
    const a = makeSong("A");
    const loading = engine.load(a.blob);
    await a.decodeStarted;
    engine.destroy(); // user leaves the practice room mid-decode
    a.failDecode(); // closing the context is what rejects it
    await loading;
    expect(failed).not.toHaveBeenCalled(); // no toast on whatever page they're on now
  });
});
