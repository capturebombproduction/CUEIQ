import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// destroy() is terminal - the player drops the engine when it unmounts. Calls still
// in flight at that moment (a download that lands late, a decode that finishes after
// the room closed) must not build a new <audio> or AudioContext and sound a song
// nobody can stop any more.

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
  constructor() {
    FakeAudio.made.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

// every decodeAudioData call waits until the test releases it
const decodes: { release: () => void }[] = [];
let contextsMade = 0;
class FakeAudioContext {
  state = "running";
  destination = {};
  constructor() {
    contextsMade++;
  }
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

const shifters = vi.hoisted(() => [] as { connected: boolean }[]);
vi.mock("soundtouchjs", () => ({
  PitchShifter: class {
    tempo = 1;
    pitch = 1;
    percentagePlayed = 0;
    connected = false;
    node = { onaudioprocess: null as unknown };
    constructor() {
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

import { PracticeAudioEngine } from "@/lib/practice-audio";

const song = (name: string) =>
  ({ name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }) as unknown as Blob;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeAudio.made = [];
  shifters.length = 0;
  decodes.length = 0;
  contextsMade = 0;
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a destroyed practice engine", () => {
  it("arms and plays nothing that is loaded into it afterwards", async () => {
    const engine = new PracticeAudioEngine();
    engine.unlock(); // the tap on the song
    engine.destroy(); // …the player went away while its file downloaded
    const before = FakeAudio.made.length;
    const contexts = contextsMade;

    // the download lands: selectSong's load() + play()
    await engine.load(song("A"));
    await engine.play();
    engine.unlock();

    expect(FakeAudio.made.length).toBe(before); // no fresh element
    expect(FakeAudio.made.filter((a) => !a.paused)).toEqual([]);
    expect(contextsMade).toBe(contexts); // no fresh context
    expect(engine.playing).toBe(false);
  });

  it("does not open a new audio context when it is destroyed while a slowed song decodes", async () => {
    const engine = new PracticeAudioEngine();
    engine.setTempo(0.5);
    engine.unlock();
    expect(contextsMade).toBe(1);

    const loading = engine.load(song("A")); // slowed: the decode starts
    await tick();
    const playing = engine.play(); // ▶ during the spinner joins that decode
    engine.destroy(); // and the member leaves the room before it lands
    decodes[0].release();
    await loading;
    await playing;
    await tick();

    expect(contextsMade).toBe(1);
    expect(shifters.filter((s) => s.connected)).toEqual([]);
    expect(engine.playing).toBe(false);
  });
});
