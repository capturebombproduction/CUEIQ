// lib/live-signal.ts's SignalTap, wired against a fake Web Audio graph. The real one needs
// Chromium (the desktop smoke plays a tone through it); what can be proven here is the SHAPE:
// live audio is zero-tolerance, and the one promise the tap makes is that it LISTENS - nothing it
// builds, the STAGE meters or CONSOLE's analysis, may ever reach an output. And CONSOLE's
// analysis must read after each player's fader, and leave nothing behind when it stops.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SignalTap } from "./live-signal";
import { kWeighting } from "./song-analysis";

class FakeNode {
  connections: { to: FakeNode; out?: number }[] = [];
  constructor(readonly kind: string, readonly ctx: FakeCtx) {
    ctx.created.push(this);
  }
  connect(to: FakeNode, out?: number) {
    this.connections.push({ to, out });
    return to;
  }
  disconnect(to?: FakeNode) {
    this.connections = to ? this.connections.filter((c) => c.to !== to) : [];
  }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  minDecibels = -100;
  maxDecibels = -30;
  level = 0;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(b: Float32Array) {
    b.fill(this.level || this.heard());
  }
  /** what the graph feeds it: the loudest track whose source reaches it through one node (the splitter) */
  private heard() {
    const feeders = this.ctx.created.filter((n) => n.connections.some((c) => c.to === this));
    let lv = 0;
    for (const s of this.ctx.created) {
      if (s instanceof FakeSource && s.connections.some((c) => feeders.includes(c.to))) lv = Math.max(lv, s.level);
    }
    return lv;
  }
  getFloatFrequencyData(b: Float32Array) {
    b.fill(-60);
  }
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
}
class FakeSource extends FakeNode {
  constructor(ctx: FakeCtx, readonly stream: { tracks: { level?: number }[] }) {
    super("source", ctx);
  }
  get level() {
    return this.stream.tracks[0]?.level ?? 0;
  }
}
class FakeIIR extends FakeNode {
  constructor(ctx: FakeCtx, readonly ff: number[], readonly fb: number[]) {
    super("iir", ctx);
  }
}
class FakeCtx {
  state = "running";
  sampleRate = 48000;
  created: FakeNode[] = [];
  destination: FakeNode;
  constructor() {
    this.destination = new FakeNode("destination", this);
    contexts.push(this);
  }
  createGain() {
    return new FakeGain("gain", this);
  }
  createAnalyser() {
    return new FakeAnalyser("analyser", this);
  }
  createChannelSplitter() {
    return new FakeNode("splitter", this);
  }
  createIIRFilter(ff: number[], fb: number[]) {
    return new FakeIIR(this, ff, fb);
  }
  createMediaStreamSource(stream: { tracks: { level?: number }[] }) {
    return new FakeSource(this, stream);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
let contexts: FakeCtx[] = [];

const track = { id: "track-1", readyState: "live" };
const fakeStream = () => ({ getAudioTracks: () => [track], addEventListener() {}, removeEventListener() {} });

const saved: Record<string, unknown> = {};
beforeEach(() => {
  contexts = [];
  const w = window as unknown as Record<string, unknown>;
  saved.AudioContext = w.AudioContext;
  saved.MediaStream = w.MediaStream;
  saved.cueiqNative = w.cueiqNative;
  w.AudioContext = FakeCtx;
  w.MediaStream = class {
    constructor(readonly tracks: unknown[]) {}
  };
  w.cueiqNative = { isElectron: true };
  (HTMLMediaElement.prototype as unknown as { captureStream: () => unknown }).captureStream = fakeStream;
});
afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  w.AudioContext = saved.AudioContext;
  w.MediaStream = saved.MediaStream;
  w.cueiqNative = saved.cueiqNative;
  delete (HTMLMediaElement.prototype as unknown as { captureStream?: unknown }).captureStream;
});

/** Every node the tap built, and whether any path from any of them reaches the output. */
function reachesOutput(ctx: FakeCtx): boolean {
  return ctx.created.some((n) => n.connections.some((c) => c.to === ctx.destination));
}
const live = (ctx: FakeCtx) => ctx.created.filter((n) => n.kind !== "destination" && (n.connections.length > 0 || ctx.created.some((m) => m.connections.some((c) => c.to === n))));

function mount() {
  const a = document.createElement("audio");
  const b = document.createElement("audio");
  Object.defineProperty(a, "volume", { value: 1, writable: true });
  const tap = new SignalTap(() => [a, b]);
  tap.attach();
  const ctx = contexts[0];
  return { tap, a, b, ctx };
}

describe("SignalTap · it listens and never plays", () => {
  it("the STAGE meters' graph ends in analysers: nothing reaches the output", () => {
    const { ctx } = mount();
    expect(ctx).toBeTruthy();
    expect(ctx.created.filter((n) => n.kind === "source")).toHaveLength(2);
    expect(reachesOutput(ctx)).toBe(false);
  });

  it("CONSOLE's analysis adds a second graph - still nothing reaches the output", () => {
    const { tap, ctx } = mount();
    const src = tap.startAnalysis();
    expect(src).not.toBeNull();
    // K-weighting, BS.1770's two stages per channel, for THIS context's rate
    const iirs = ctx.created.filter((n): n is FakeIIR => n instanceof FakeIIR);
    expect(iirs).toHaveLength(4);
    const [shelf] = kWeighting(48000);
    expect(iirs[0].ff).toEqual(shelf.slice(0, 3));
    expect(iirs[0].fb).toEqual([1, shelf[3], shelf[4]]);
    expect(reachesOutput(ctx)).toBe(false);
    src!.stop();
  });
});

describe("SignalTap · CONSOLE's analysis", () => {
  it("reads after each player's fader: its gain follows the volume, a muted player is 0", () => {
    const { tap, a, ctx } = mount();
    const src = tap.startAnalysis()!;
    const gains = () => ctx.created.filter((n): n is FakeGain => n instanceof FakeGain && n.connections.length > 0 && n.connections[0].to.kind === "gain");
    a.volume = 0.5;
    src.read();
    expect(gains().map((g) => g.gain.value)).toContain(0.5);
    a.muted = true;
    src.read();
    expect(gains().map((g) => g.gain.value)).not.toContain(0.5);
    expect(gains().map((g) => g.gain.value)).toContain(0);
    src.stop();
  });

  it("the momentary block: the last 400 ms of each K-weighted channel, summed", () => {
    const { tap, ctx } = mount();
    const src = tap.startAnalysis()!;
    const big = ctx.created.filter((n): n is FakeAnalyser => n instanceof FakeAnalyser && n.fftSize === 32768);
    expect(big).toHaveLength(2);
    big[0].level = 0.5;
    big[1].level = 0.25;
    const f = src.read()!;
    expect(f.kMeanSquare).toBeCloseTo(0.25 + 0.0625, 6);
    expect(f.sampleRate).toBe(48000);
    expect(f.bins).toHaveLength(4096);
    src.stop();
  });

  it("no reading while the context is not running (no verdicts from zeros)", () => {
    const { tap, ctx } = mount();
    const src = tap.startAnalysis()!;
    ctx.state = "suspended";
    expect(src.read()).toBeNull();
    src.stop();
  });

  it("stays while anyone uses it; the last stop() leaves nothing connected but the meters", () => {
    const { tap, ctx } = mount();
    const before = live(ctx).length;
    const one = tap.startAnalysis()!;
    const two = tap.startAnalysis()!;
    expect(live(ctx).length).toBeGreaterThan(before);
    one.stop();
    one.stop(); // twice is once
    expect(two.read()).not.toBeNull();
    two.stop();
    expect(two.read()).toBeNull();
    expect(live(ctx).length).toBe(before);
    // and it can be built again
    const three = tap.startAnalysis()!;
    expect(three.read()).not.toBeNull();
    three.stop();
  });

  it("close() takes the analysis down with the tap", () => {
    const { tap } = mount();
    const src = tap.startAnalysis()!;
    tap.close();
    expect(src.read()).toBeNull();
  });
});

describe("SignalTap · it hears the song that is playing NOW", () => {
  // Chromium (Electron 42, measured 2026-10-16): a player's captureStream() GAINS a track at
  // every new load and drops them only when a file plays to its natural end. A cut - จบโชว์
  // then START, NEXT mid-song - leaves the old track in the stream, still "live" but carrying
  // nothing, AHEAD of the new one. Listening to the first live track read zeros under a song
  // that was sounding: NO SIGNAL on a show that was playing (พี่ 2026-10-16).
  type FakeTrack = { id: string; readyState: string; level: number };
  function player(tracks: FakeTrack[]) {
    const el = document.createElement("audio");
    const st = { paused: true, readyState: 0 };
    Object.defineProperty(el, "paused", { get: () => st.paused });
    Object.defineProperty(el, "ended", { get: () => false });
    Object.defineProperty(el, "readyState", { get: () => st.readyState });
    const stream = { getAudioTracks: () => tracks, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(el, "captureStream", { value: () => stream });
    const play = () => {
      st.paused = false;
      st.readyState = 4;
    };
    return { el, st, play };
  }
  const feeding = (ctx: FakeCtx) => ctx.created.filter((n) => n instanceof FakeSource && n.connections.length > 0);

  it("after a cut, the newest live track is the song - not the dead one ahead of it", () => {
    const tracks: FakeTrack[] = [{ id: "show-1-last-song", readyState: "live", level: 0.3 }];
    const a = player(tracks);
    const b = player([]);
    const tap = new SignalTap(() => [a.el, b.el]);
    tap.attach();
    const ctx = contexts[0];
    a.play();
    expect(tap.read().rmsL).toBeCloseTo(0.3, 5);
    // จบโชว์ paused it mid-song; it falls silent but keeps its place in the stream
    tracks[0].level = 0;
    a.st.paused = true;
    // START: the first song loads on the same player - Chromium ADDS its track behind the old one
    tracks.push({ id: "show-2-first-song", readyState: "live", level: 0.35 });
    a.play();
    const r = tap.read();
    expect(r.ready).toBe(true);
    expect(r.rmsL).toBeCloseTo(0.35, 5);
    // NEXT mid-song: a third track, the two before it dead - still the one playing, and only it
    tracks[1].level = 0;
    tracks.push({ id: "show-2-second-song", readyState: "live", level: 0.5 });
    expect(tap.read().rmsL).toBeCloseTo(0.5, 5);
    expect(feeding(ctx)).toHaveLength(1);
    // the song plays to its end: Chromium drops every track; the next load brings one back
    tracks.length = 0;
    a.st.paused = true;
    expect(tap.read().rmsL).toBe(0);
    tracks.push({ id: "show-2-third-song", readyState: "live", level: 0.25 });
    a.play();
    expect(tap.read().rmsL).toBeCloseTo(0.25, 5);
    expect(feeding(ctx)).toHaveLength(1);
  });

  it("a playing player it cannot hear gives no reading - not a reading of silence", () => {
    // the same file played again after it ended: Chromium dropped its tracks at the end and a
    // replay without a reload adds none. Measured: the copy is empty while the room hears it.
    const a = player([]);
    const b = player([]);
    const tap = new SignalTap(() => [a.el, b.el]);
    tap.attach();
    // nothing playing: quiet is the truth, the meters read it
    expect(tap.read().ready).toBe(true);
    a.play();
    // playing and unheard: no verdict (the NO SIGNAL watch is told the tap is not ready)
    expect(tap.read().ready).toBe(false);
    // the other player sounding with a track of its own does not make the blind one heard
    const bt: FakeTrack[] = [{ id: "pre-roll", readyState: "live", level: 0.4 }];
    const c = player(bt);
    const tap2 = new SignalTap(() => [a.el, c.el]);
    tap2.attach();
    c.play();
    expect(tap2.read().ready).toBe(false);
    // once the blind one stops, the reading is whole again
    a.st.paused = true;
    expect(tap2.read().ready).toBe(true);
    expect(tap2.read().rmsL).toBeCloseTo(0.4, 5);
  });
});
