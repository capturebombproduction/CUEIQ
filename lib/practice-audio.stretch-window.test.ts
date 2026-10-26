import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The slowed-down ("stretch") backend has a
// decode window - seconds for a big WAV - in which the engine and the player disagree
// about whether anything is playing. These pin what a user does in that window.

class FakeAudio {
  static made: FakeAudio[] = [];
  preload = "";
  volume = 1;
  playbackRate = 1;
  paused = true;
  currentTime = 0;
  duration = 200;
  readyState = 4;
  src = "";
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
    this.paused = false;
    this.emit("play");
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    // the browser fires 'pause' on a later task - by then the engine has moved on
    queueMicrotask(() => this.emit("pause"));
  }
}

// every decodeAudioData call waits until the test releases it
const decodes: { release: () => void }[] = [];
class FakeAudioContext {
  state = "running";
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} };
  }
  decodeAudioData = vi.fn(
    () =>
      new Promise<AudioBuffer>((res) => {
        decodes.push({ release: () => res({ duration: 200 } as unknown as AudioBuffer) });
      })
  );
}

type FakeShifter = { connected: boolean; percentagePlayed: number; builtAt: number };
const shifters = vi.hoisted(() => [] as FakeShifter[]);
vi.mock("soundtouchjs", () => ({
  PitchShifter: class {
    tempo = 1;
    pitch = 1;
    percentagePlayed = 0;
    connected = false;
    builtAt = 0;
    node = { onaudioprocess: null as unknown };
    constructor() {
      shifters.push(this as unknown as FakeShifter);
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

import { PracticeAudioEngine } from "@/lib/practice-audio";

const song = (name: string) =>
  ({ name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }) as unknown as Blob;
const tick = () => new Promise((r) => setTimeout(r, 0));

let ctx: FakeAudioContext;
beforeEach(() => {
  FakeAudio.made = [];
  shifters.length = 0;
  decodes.length = 0;
  ctx = new FakeAudioContext();
  vi.stubGlobal("window", {
    AudioContext: class {
      constructor() {
        return ctx;
      }
    },
  });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stretch decode window — a song picked while slowed down", () => {
  it("tells the player it stopped when load() silences the old song, not seconds later", async () => {
    const engine = new PracticeAudioEngine();
    const said: boolean[] = [];
    engine.onPlayingChange = (p) => said.push(p);
    engine.setTempo(0.75);
    engine.unlock();
    // song A, slowed, playing
    const loadingA = engine.load(song("A"));
    await tick();
    decodes[0].release();
    await loadingA;
    await engine.play();
    expect(shifters[0].connected).toBe(true);
    said.length = 0;

    // the user picks song B (a big WAV): its decode takes seconds
    const loadingB = engine.load(song("B"));
    await tick();
    expect(shifters[0].connected).toBe(false); // A is already silent
    expect(engine.playing).toBe(false);
    // ...and the player is told at once, not when the decode lands seconds later
    expect(said).toContain(false);
    decodes[1].release();
    await loadingB;
  });

  it("a tap on the main key during that decode does not start a second decode that restarts the song", async () => {
    const engine = new PracticeAudioEngine();
    engine.setTempo(0.75);
    engine.unlock();
    const loadingA = engine.load(song("A"));
    await tick();
    decodes[0].release();
    await loadingA;
    await engine.play();

    // selectSong(B): load() then play(), as practice-player.tsx:469/483 do
    const selecting = (async () => {
      await engine.load(song("B"));
      await engine.play();
    })();
    await tick();
    // the key still reads ⏸ (see above); the press goes through engine.toggle()
    // (practice-player.tsx:676), which sees _playing === false and calls play()
    engine.toggle();
    await tick();
    decodes[1].release(); // load()'s decode of B
    await selecting;
    const firstB = shifters[shifters.length - 1];
    expect(firstB.connected).toBe(true); // B is playing
    firstB.percentagePlayed = 0.3; // ...and has been for a while

    // the toggle's own decode lands later
    decodes[2]?.release();
    await tick();
    await tick();
    // no THIRD decode (A, B, B again - two copies of B in memory) whose landing tore
    // down the playing shifter and started B over at 0:00
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(shifters[shifters.length - 1]).toBe(firstB);
  });
});

describe("stretch decode window — speed tapped mid-song (native → slowed)", () => {
  it("a pause pressed while the first slow-down decodes is not overruled when the decode lands", async () => {
    const engine = new PracticeAudioEngine();
    engine.unlock();
    await engine.load(song("A"));
    await engine.play(); // 1x, native
    const el = FakeAudio.made.find((a) => a.src === "blob:x")!;
    expect(el.paused).toBe(false);

    engine.setTempo(0.5); // the speed key: native → stretch, decode starts
    await tick();
    expect(el.paused).toBe(true); // the element is already quiet
    // ⏸ during the spinner: practice-player togglePlay → engine.toggle()
    engine.toggle();
    await tick();
    decodes[0].release();
    await tick();
    await tick();
    await tick();
    // pause() used to find no shifter yet and do nothing (_playing stayed true), so
    // doSwitch's `if (wasPlaying) await this.play()` started the song
    const s = shifters[shifters.length - 1];
    expect(s?.connected ?? false).toBe(false);
    expect(engine.playing).toBe(false);
  });
});
