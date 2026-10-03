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
    b.fill(this.level);
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
  createMediaStreamSource() {
    return new FakeNode("source", this);
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
