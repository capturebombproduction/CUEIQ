import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "เล่นซ้อน" (พี่ 2026-10-07) — a set's next song comes in N seconds before this one
// ends. The engine plays one song at a time, so handOff() lets the song now
// sounding play on by itself (a "tail") while load() puts the next one up. What
// these pin: the tail is never cut, never moves the scrubber, never ends the song
// on screen; the next song plays on the element primed inside a tap (WebKit grants
// play per element and the hand-off has no tap); pause silences the tail too.

// node env: minimal browser fakes that actually dispatch the events the engine
// listens for, so a tail's 'timeupdate' / 'ended' can be told apart from the song's.
class FakeAudio {
  static made: FakeAudio[] = [];
  /** WebKit refusing a play that no tap allowed */
  static refuse = false;
  preload = "";
  volume = 1;
  playbackRate = 1;
  paused = true;
  currentTime = 0;
  duration = 200;
  readyState = 4;
  src = "";
  plays = 0;
  private listeners = new Map<string, Set<() => void>>();
  constructor() {
    FakeAudio.made.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    Array.from(this.listeners.get(type) ?? []).forEach((fn) => fn());
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
  play() {
    this.plays++;
    if (FakeAudio.refuse) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    this.emit("play");
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  /** playback reaches the end of the file */
  finish() {
    this.paused = true;
    this.emit("pause");
    this.emit("ended");
  }
}

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  decodeAudioData = vi.fn((_arr: ArrayBuffer) =>
    Promise.resolve({ duration: 200 } as unknown as AudioBuffer)
  );
}

const shifters = vi.hoisted(() => [] as unknown[]);
vi.mock("soundtouchjs", () => ({
  PitchShifter: class {
    tempo = 1;
    pitch = 1;
    percentagePlayed = 0;
    connected = false;
    node = { onaudioprocess: null as unknown };
    onEnd: () => void;
    constructor(_c: unknown, _b: unknown, _s: number, onEnd: () => void) {
      this.onEnd = onEnd;
      shifters.push(this);
    }
    on() {}
    connect() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  },
}));

import { PracticeAudioEngine } from "./practice-audio";

type FakeShifter = { connected: boolean; onEnd: () => void };

const song = (name: string) =>
  ({ name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }) as unknown as Blob;

let urls = 0;
const revoked: string[] = [];
let ctx: FakeAudioContext;

beforeEach(() => {
  FakeAudio.made = [];
  FakeAudio.refuse = false;
  shifters.length = 0;
  revoked.length = 0;
  urls = 0;
  ctx = new FakeAudioContext();
  vi.stubGlobal("window", {
    AudioContext: class {
      constructor() {
        return ctx; // one context per test, so its decode calls can be counted
      }
    },
  });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++urls}`,
    revokeObjectURL: (u: string) => revoked.push(u),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** a song playing natively (1×), started with a tap as the player does */
async function playing(engine: PracticeAudioEngine, name: string) {
  engine.unlock();
  await engine.load(song(name));
  await engine.play();
  return FakeAudio.made.find((a) => a.src === `blob:${urls}`)!;
}

describe("PracticeAudioEngine.handOff — native (1×)", () => {
  it("the song playing sounds on to its end while the next plays on the primed spare", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    const spare = FakeAudio.made[0]; // made + primed by unlock(), inside the tap
    expect(spare).not.toBe(a);
    expect(spare.plays).toBe(1); // the silent prime

    expect(engine.handOff()).toBe(true);
    await engine.load(song("B"));
    await engine.play();
    expect(a.paused).toBe(false); // A is not cut…
    expect(spare.src).toBe("blob:2"); // …B is on the element that may play untapped
    expect(spare.paused).toBe(false);
    expect(FakeAudio.made).toHaveLength(2);
    expect(revoked).not.toContain("blob:1"); // A's file stays readable while it plays
  });

  it("a tail never moves the scrubber, never ends the song on screen", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    await engine.play();
    const onTime = vi.fn();
    const onEnded = vi.fn();
    const onPlaying = vi.fn();
    engine.onTime = onTime;
    engine.onEnded = onEnded;
    engine.onPlayingChange = onPlaying;

    a.currentTime = 199;
    a.emit("timeupdate");
    a.finish();
    expect(onTime).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
    expect(onPlaying).not.toHaveBeenCalled();
    expect(engine.playing).toBe(true); // B plays on
    // a finished tail lets go of its file
    expect(revoked).toContain("blob:1");
    expect(a.src).toBe("");
  });

  it("a finished tail's element is the next hand-off's spare — no new element", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    await engine.play();
    a.finish();

    engine.handOff();
    await engine.load(song("C"));
    await engine.play();
    expect(a.src).toBe("blob:3"); // C plays where A did: it has played, so it may again
    expect(a.paused).toBe(false);
    expect(FakeAudio.made).toHaveLength(2);
  });

  it("pause silences a tail too", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    await engine.play();
    engine.pause();
    expect(a.paused).toBe(true);
    expect(engine.playing).toBe(false);
    expect(revoked).toContain("blob:1");
  });

  it("stopTails() cuts a tail and leaves the song on screen alone", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    await engine.play();
    engine.stopTails();
    expect(a.paused).toBe(true);
    expect(engine.playing).toBe(true);
  });

  it("with nothing playing there is nothing to hand off — the next song replaces it", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.pause();
    expect(engine.handOff()).toBe(false);
    await engine.load(song("B"));
    expect(a.src).toBe("blob:2"); // same element, as a plain song change
  });

  it("the volume reaches a tail", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    engine.setVolume(0.3);
    expect(a.volume).toBe(0.3);
  });

  it("a refused prime does not count: no hand-off until a tap primes the spare", async () => {
    const engine = new PracticeAudioEngine();
    FakeAudio.refuse = true; // the first unlock() came from outside a tap
    engine.unlock();
    await new Promise((r) => setTimeout(r, 0));
    FakeAudio.refuse = false;
    await engine.load(song("A"));
    await engine.play();
    expect(engine.canHandOff).toBe(false); // the next song would start silent
    engine.unlock(); // a real tap
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.canHandOff).toBe(true);
  });

  it("canHandOff needs a song playing", async () => {
    const engine = new PracticeAudioEngine();
    await playing(engine, "A");
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.canHandOff).toBe(true);
    engine.pause();
    expect(engine.canHandOff).toBe(false);
  });

  it("the next song's length is unknown (0) until its own metadata — never the last song's", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    a.emit("loadedmetadata");
    expect(engine.songDuration).toBe(200);
    engine.handOff();
    await engine.load(song("B"));
    expect(engine.songDuration).toBe(0);
    expect(engine.duration).toBe(200); // the scrubber's view is unchanged
    const b = FakeAudio.made.find((x) => x.src === "blob:2")!;
    b.duration = 31;
    b.emit("loadedmetadata");
    expect(engine.songDuration).toBe(31);
  });

  it("mid hand-off it says so, and a pause there is reported", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    const onPlaying = vi.fn();
    engine.onPlayingChange = onPlaying;
    expect(engine.handingOff).toBe(false);
    engine.handOff();
    expect(engine.handingOff).toBe(true); // A sounding, B not started
    onPlaying.mockClear();
    engine.pause();
    expect(a.paused).toBe(true);
    expect(onPlaying).toHaveBeenCalledWith(false);
    expect(engine.handingOff).toBe(false);
  });

  it("a tail whose file errors is let go — it would never 'end'", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    engine.handOff();
    await engine.load(song("B"));
    a.emit("error");
    expect(revoked).toContain("blob:1");
    expect(engine.handingOff).toBe(false);
  });

  it("the live position reads the element between timeupdates", async () => {
    const engine = new PracticeAudioEngine();
    const a = await playing(engine, "A");
    a.currentTime = 42.7; // no timeupdate yet
    expect(engine.position).toBe(42.7);
  });
});

describe("PracticeAudioEngine.handOff — slowed down (stretch)", () => {
  it("the tail keeps its shifter sounding; its end touches nothing on screen", async () => {
    const engine = new PracticeAudioEngine();
    engine.setTempo(0.5);
    engine.unlock();
    await engine.load(song("A"));
    await engine.play();
    const sa = shifters[shifters.length - 1] as FakeShifter;
    expect(sa.connected).toBe(true);

    expect(engine.handOff()).toBe(true);
    await engine.load(song("B"));
    await engine.play();
    const sb = shifters[shifters.length - 1] as FakeShifter;
    expect(sb).not.toBe(sa);
    expect(sa.connected).toBe(true); // A sounds on under B
    expect(sb.connected).toBe(true);

    const onEnded = vi.fn();
    engine.onEnded = onEnded;
    sa.onEnd(); // A runs out
    expect(sa.connected).toBe(false);
    expect(onEnded).not.toHaveBeenCalled();
    expect(sb.connected).toBe(true);
  });

  it("preload() decodes the next song ahead, and its load does not decode again", async () => {
    const engine = new PracticeAudioEngine();
    engine.setTempo(0.5);
    engine.unlock();
    await engine.load(song("A"));
    await engine.play();
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);

    const b = song("B");
    engine.preload(b);
    engine.preload(b); // once per song, however often it is asked
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);

    engine.handOff();
    await engine.load(b);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it("at 1× preload() does nothing — the element streams", async () => {
    const engine = new PracticeAudioEngine();
    engine.preload(song("B"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
  });
});
