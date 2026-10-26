// 2026-10-27 bug hunt: at 0.75× a big WAV (B) was tapped and, while it decoded, a short
// song (C) - C decoded first and played. When B's decode landed, load(B) still ended by
// telling the player "stopped": the key showed ▶ over C, the synced metronome stopped,
// the wake lock was let go and the auto-log stopped counting, all while C kept
// sounding. Pinned: a load whose song was replaced while it decoded says nothing once
// its decode lands - the newer load owns the transport and what is reported about it.
// Harness copied from lib/practice-audio.stretch-window.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    queueMicrotask(() => this.emit("pause"));
  }
}

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

type FakeShifter = { connected: boolean };
const shifters = vi.hoisted(() => [] as FakeShifter[]);
vi.mock("soundtouchjs", () => ({
  PitchShifter: class {
    tempo = 1;
    pitch = 1;
    percentagePlayed = 0;
    connected = false;
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

describe("PracticeAudioEngine — a slowed-down load replaced while it decodes", () => {
  it("a superseded song's late decode does not report 'stopped' over the song now playing", async () => {
    const engine = new PracticeAudioEngine();
    const said: boolean[] = [];
    engine.onPlayingChange = (p) => said.push(p);
    engine.setTempo(0.75);
    engine.unlock();

    // practice-player selectSong(B): a big WAV, decoding for seconds
    const loadingB = engine.load(song("B"));
    await tick();
    // the user changes their mind: selectSong(C) — a short file, decodes first
    const selectingC = (async () => {
      await engine.load(song("C"));
      await engine.play();
    })();
    await tick();
    decodes[1].release(); // C's decode
    await selectingC;
    expect(engine.playing).toBe(true);
    expect(said[said.length - 1]).toBe(true); // the key says ⏸

    // B's decode lands late (selectSong(B) is stale and bails out after load())
    decodes[0].release();
    await loadingB;
    await tick();
    // C is still playing...
    expect(engine.playing).toBe(true);
    expect(shifters[shifters.length - 1].connected).toBe(true);
    // ...so the last thing the player was told must not be "stopped"
    expect(said[said.length - 1]).toBe(true);
  });
});
