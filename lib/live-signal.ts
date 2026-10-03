// Live Mode's Signal (the STAGE view's meters and alarms): what the show machine is actually
// sending, measured from the two players live-mode.tsx already runs.
//
// ⚠️ THE TAP NEVER TOUCHES THE AUDIO PATH. It listens to a COPY, HTMLMediaElement.captureStream(),
// and its Web Audio graph ends in two AnalyserNodes connected to nothing. Not
// createMediaElementSource: that one REROUTES the element through the graph (the desktop smoke's
// measureTheSound uses it because a test may; a show may not). Live audio is zero-tolerance.
//
// ⚠️ CHROMIUM ONLY (the desktop app). Firefox's captureStream SILENCES the element it copies,
// and Safari has none; signalTapSupported() is the gate and the web build never taps.
//
// What it can say: the file is producing a signal, how loud, whether it clips, and whether the
// playhead is moving. What it cannot: whether the cable after the computer, the mixer or the PA
// pass it on. The strip says so in its title.
//
// Pure helpers first (unit-tested in lib/live-signal.test.ts), the Web Audio part last.

/** Linear amplitude → dBFS (−Infinity for silence). */
export const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** A meter's position 0..1 for a linear level: −48..0 dBFS. */
export const METER_FLOOR_DB = -48;
export function meterPos(linear: number): number {
  const db = toDb(linear);
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** RMS and peak of one block of samples. */
export function blockLevels(buf: Float32Array): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return { rms: buf.length ? Math.sqrt(sum / buf.length) : 0, peak };
}

/** A sample at or over this is a clip (digital full scale, with float rounding). */
export const CLIP_LEVEL = 0.999;

// ── NO SIGNAL ─────────────────────────────────────────────────────────────────────────
/** Under this RMS (−60 dBFS) a playing file counts as silent. */
export const SILENT_RMS = 0.001;
/** Continuous silence (or a frozen playhead) this long while playing = the alarm. */
export const SILENCE_ALARM_MS = 3000;
/** No verdict in the first moments of a track: decoders start, fades start from nothing. */
export const START_GRACE_MS = 2500;
/** Nor in its last seconds, where a fade-out or a ring-out is the song, not a fault. */
export const END_GRACE_S = 4;
/** A playhead that has not moved for this long, while playing, is stalled. */
export const FROZEN_AFTER_MS = 1000;

export interface SilenceState {
  /** when the current silent / frozen stretch began */
  since: number | null;
  /** no alarm before this (a track just started) */
  graceUntil: number;
  /** the track the grace belongs to */
  trackKey: string | null;
  lastTime: number | null;
  lastMove: number;
}
export const initialSilence = (): SilenceState => ({ since: null, graceUntil: 0, trackKey: null, lastTime: null, lastMove: 0 });

export interface SilenceInput {
  now: number;
  /** this device is the one sounding the show, and a file is playing (not paused) */
  playing: boolean;
  /** which track (item id + file), so a change restarts the grace */
  trackKey: string | null;
  /** the tap is running (an AudioContext that is suspended reads zeros - no verdict) */
  tapReady: boolean;
  /** the file's own level right now, pre-volume (linear RMS, loudest channel) */
  rms: number;
  /** the player's position and length, seconds */
  currentTime: number;
  duration: number;
  /** the song's own waveform says this stretch is quiet (lib/song-analysis.ts) */
  expectedQuiet: boolean;
}

export type SilenceVerdict = null | "silent" | "frozen";

/**
 * One step of the NO SIGNAL watch. Two faults, one alarm: the file plays but nothing comes
 * out ("silent": a decode of zeros, a dead pipeline), or the playhead stopped moving while
 * the player says it plays ("frozen": a stall). Never while paused, in a track's first
 * START_GRACE_MS or last END_GRACE_S, where the song itself is quiet, or without a running tap.
 */
export function stepSilence(s: SilenceState, i: SilenceInput): { state: SilenceState; verdict: SilenceVerdict } {
  let next: SilenceState = { ...s };
  if (!i.playing || !i.tapReady || i.trackKey === null) {
    return { state: { ...initialSilence(), trackKey: i.playing ? i.trackKey : null }, verdict: null };
  }
  if (i.trackKey !== s.trackKey) {
    next = { since: null, graceUntil: i.now + START_GRACE_MS, trackKey: i.trackKey, lastTime: i.currentTime, lastMove: i.now };
  }
  if (next.lastTime === null || Math.abs(i.currentTime - next.lastTime) > 0.01) {
    next.lastTime = i.currentTime;
    next.lastMove = i.now;
  }
  const nearEnd = i.duration > 0 && i.duration - i.currentTime < END_GRACE_S;
  // A second without progress is a stall; its clock starts when the playhead STOPPED, so a
  // stall alarms SILENCE_ALARM_MS after it began, like silence does.
  const frozen = i.now - next.lastMove >= FROZEN_AFTER_MS;
  const quiet = i.rms < SILENT_RMS && !i.expectedQuiet;
  if ((quiet || frozen) && !nearEnd) {
    if (next.since === null) next.since = frozen ? next.lastMove : i.now;
  } else {
    next.since = null;
  }
  const due = next.since !== null && i.now - next.since >= SILENCE_ALARM_MS && i.now >= next.graceUntil;
  return { state: next, verdict: due ? (frozen ? "frozen" : "silent") : null };
}

// ── OUTPUT DEVICE ─────────────────────────────────────────────────────────────────────
export type OutputKind = "builtin" | "external" | "unknown";

/**
 * Is this output the computer's own speaker? A show's sound belongs on the line / USB /
 * headphone output wired to the mixer; the built-in speaker is almost always a mistake (the
 * cable fell out, the interface was unplugged and the system fell back). Labels as macOS and
 * Windows give them: "MacBook Pro Speakers", "Built-in Output", "Speakers (Realtek(R) Audio)".
 * A headphone jack is NOT built-in for this purpose: at idol shows it is the usual PA feed.
 */
export function classifyOutput(label: string | null | undefined): OutputKind {
  const l = (label ?? "").replace(/^default\s*-\s*/i, "").trim();
  if (!l) return "unknown";
  if (/headphone|หูฟัง|line out|line-out|spdif|optical|hdmi|displayport|usb|bluetooth|airpods|interface/i.test(l)) return "external";
  if (/(macbook|imac|mac mini|mac studio|built-?in|internal).*(speaker|output)|ลำโพงในตัว|ลำโพงของเครื่อง/i.test(l)) return "builtin";
  if (/^speakers?\s*\((realtek|conexant|idt|intel|sst|high definition audio|cirrus|synaptics)/i.test(l)) return "builtin";
  return "external";
}

/** The label to show: the chosen device's, else the system default's (minus "Default - "). */
export function outputLabel(sinkId: string, devices: readonly { deviceId: string; label: string }[]): string | null {
  const pick = sinkId
    ? devices.find((d) => d.deviceId === sinkId)
    : devices.find((d) => d.deviceId === "default") ?? devices[0];
  if (!pick || !pick.label) return null;
  return pick.label.replace(/^default\s*-\s*/i, "").trim() || null;
}

// ── THE TAP (Web Audio; Chromium only) ────────────────────────────────────────────────
type CapturableElement = HTMLMediaElement & { captureStream?: () => MediaStream };

/** Only where a capture is a pure copy: Chromium, i.e. the desktop app. */
export function signalTapSupported(): boolean {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return false;
  const isDesktop = !!(window as { cueiqNative?: { isElectron?: boolean } }).cueiqNative?.isElectron;
  const canCapture = typeof (HTMLMediaElement.prototype as CapturableElement).captureStream === "function";
  return isDesktop && canCapture;
}

export interface SignalReading {
  /** the tap is running; false = no verdict possible (not started, suspended, unsupported) */
  ready: boolean;
  /** pre-volume, the loudest of the tapped players, per channel */
  rmsL: number;
  rmsR: number;
  peakL: number;
  peakR: number;
}

interface Tap {
  el: CapturableElement;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode | null;
  trackId: string | null;
  left: AnalyserNode;
  right: AnalyserNode;
  onTracks: () => void;
}

/**
 * Taps the given players. Each one's captureStream() feeds a splitter and two analysers that
 * go nowhere. A player's capture changes tracks when its source changes (a new song), so the
 * source node is rebuilt on addtrack / removetrack. The AudioContext may start suspended under
 * the autoplay policy; it is resumed on the next press anywhere (START, NEXT - a show is all
 * presses) and whenever a player starts (the page is activated by then, and activation is
 * sticky). Until it runs, read() says ready: false and nothing alarms.
 */
export class SignalTap {
  private ctx: AudioContext | null = null;
  private taps: Tap[] = [];
  private buf = new Float32Array(1024);
  private unlock = () => {
    this.ctx?.resume().catch(() => {});
  };

  constructor(private readonly elements: () => (HTMLMediaElement | null)[]) {}

  /** Idempotent; re-run after the players are (re)created. Never throws. */
  attach(): void {
    if (!signalTapSupported()) return;
    try {
      if (!this.ctx) {
        // sinkId "none": the graph renders with NO output device opened at all - nothing
        // here should ever hold, wake or share the show's sound card. Older engines take
        // the plain context, whose output only ever carries silence (nothing reaches it).
        try {
          this.ctx = new AudioContext({ latencyHint: "playback", sinkId: { type: "none" } } as AudioContextOptions);
        } catch {
          this.ctx = new AudioContext({ latencyHint: "playback" });
        }
        document.addEventListener("pointerdown", this.unlock, true);
        document.addEventListener("keydown", this.unlock, true);
      }
      for (const el of this.elements()) {
        if (!el || this.taps.some((t) => t.el === el)) continue;
        this.tap(el as CapturableElement);
      }
    } catch {
      /* a meter that cannot start is a meter that is absent - never a broken show */
    }
  }

  private tap(el: CapturableElement): void {
    if (!this.ctx || !el.captureStream) return;
    const stream = el.captureStream();
    const splitter = this.ctx.createChannelSplitter(2);
    const left = this.ctx.createAnalyser();
    const right = this.ctx.createAnalyser();
    left.fftSize = right.fftSize = 1024;
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    const t: Tap = { el, stream, source: null, trackId: null, left, right, onTracks: () => {} };
    t.onTracks = () => {
      const track = stream.getAudioTracks().find((x) => x.readyState === "live") ?? null;
      if ((track?.id ?? null) === t.trackId) return;
      try {
        t.source?.disconnect();
      } catch {
        /* already gone */
      }
      t.source = null;
      t.trackId = track?.id ?? null;
      if (!track || !this.ctx) return;
      t.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      t.source.connect(splitter);
    };
    stream.addEventListener("addtrack", t.onTracks);
    stream.addEventListener("removetrack", t.onTracks);
    el.addEventListener("playing", t.onTracks);
    el.addEventListener("play", this.unlock);
    t.onTracks();
    this.taps.push(t);
  }

  read(): SignalReading {
    const out: SignalReading = { ready: false, rmsL: 0, rmsR: 0, peakL: 0, peakR: 0 };
    if (!this.ctx || this.ctx.state !== "running") return out;
    out.ready = true;
    for (const t of this.taps) {
      if (!t.source) continue;
      // keep the capture's track current even if an event was missed
      t.onTracks();
      t.left.getFloatTimeDomainData(this.buf);
      const a = blockLevels(this.buf);
      t.right.getFloatTimeDomainData(this.buf);
      const b = blockLevels(this.buf);
      out.rmsL = Math.max(out.rmsL, a.rms);
      out.peakL = Math.max(out.peakL, a.peak);
      out.rmsR = Math.max(out.rmsR, b.rms);
      out.peakR = Math.max(out.peakR, b.peak);
    }
    return out;
  }

  close(): void {
    document.removeEventListener("pointerdown", this.unlock, true);
    document.removeEventListener("keydown", this.unlock, true);
    for (const t of this.taps) {
      t.stream.removeEventListener("addtrack", t.onTracks);
      t.stream.removeEventListener("removetrack", t.onTracks);
      t.el.removeEventListener("playing", t.onTracks);
      t.el.removeEventListener("play", this.unlock);
      try {
        t.source?.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.taps = [];
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
