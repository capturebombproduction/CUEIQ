// ---------------------------------------------------------------------------
// Practice Mode audio engine — high-quality, pitch-preserving slow-down.
//
// The first cut of Practice Mode slowed audio with the native
// `HTMLAudioElement.playbackRate` + `preservesPitch`. That works, but on iOS
// Safari the native time-stretch is low quality (warbly) and on some versions
// preservesPitch is ignored entirely (the key drops). This engine replaces it
// with SoundTouchJS, a WSOLA time-stretcher that runs through the Web Audio
// graph and behaves identically across browsers, including iOS Safari.
//
// Trade-off: SoundTouch needs the whole song decoded into an AudioBuffer (it
// can't stream). The practice player already downloads the full file blob from
// R2 before playing, so we just decode that blob once per song — the decode
// happens inside the existing "loading" spinner. Only one decoded buffer is
// kept in memory at a time.
//
// The player talks ONLY to this class; it never touches Web Audio directly.
// Slow-down lives in Practice Mode only — Live Mode never uses this.
// ---------------------------------------------------------------------------

import { PitchShifter } from "soundtouchjs";

// SoundTouch drives playback through a ScriptProcessorNode whose callback fires
// every `BUFFER_SIZE / sampleRate` seconds (~93ms at 44.1kHz). Smaller = tighter
// A-B loop / scrubber updates, at a little more CPU. 4096 is the library default.
const BUFFER_SIZE = 4096;

export class PracticeAudioEngine {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private shifter: PitchShifter | null = null;
  private buffer: AudioBuffer | null = null;

  private _tempo = 1; // time-stretch factor (1 = normal, 0.5 = half speed)
  private _volume = 1; // 0..1
  private _playing = false;
  private _duration = 0;
  private _time = 0;
  private _ended = false;
  private _kicked = false; // has the iOS silent-buffer unlock run?

  // The player assigns these; defaults are no-ops so the engine is safe pre-wiring.
  onTime: (seconds: number) => void = () => {};
  onDuration: (seconds: number) => void = () => {};
  onPlayingChange: (playing: boolean) => void = () => {};
  onEnded: () => void = () => {};

  get currentTime() {
    return this._time;
  }
  get duration() {
    return this._duration;
  }
  get playing() {
    return this._playing;
  }
  get tempo() {
    return this._tempo;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /**
   * Unlock audio. Call this SYNCHRONOUSLY from inside a user gesture (the tap
   * that starts playback / changes speed). iOS Safari only lets an AudioContext
   * start — and only honours a silent-buffer "kick" — from within a gesture, so
   * doing it here keeps the context running through the later async decode/play.
   */
  unlock() {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    if (!this._kicked) {
      try {
        const b = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(ctx.destination);
        src.start(0);
        this._kicked = true;
      } catch {
        /* ignore — best-effort unlock */
      }
    }
  }

  private decode(ctx: AudioContext, arr: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
      // The promise form is standard; passing the success/error callbacks too
      // keeps older Safari (callback-only decodeAudioData) working.
      const ret = ctx.decodeAudioData(arr, resolve, reject) as unknown as
        | Promise<AudioBuffer>
        | undefined;
      if (ret && typeof ret.then === "function") ret.then(resolve, reject);
    });
  }

  /** Decode a new song and arm it, paused at 0. Does not auto-play. */
  async load(blob: Blob): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume().catch(() => {});
    // Drop the previous song first so we don't hold two decoded buffers at once.
    this.teardownShifter();
    this.buffer = null;
    const arr = await blob.arrayBuffer();
    const buffer = await this.decode(ctx, arr);
    this.buffer = buffer;
    this._duration = buffer.duration;
    this._time = 0;
    this._ended = false;
    this._playing = false;
    this.buildShifter(0);
    this.onDuration(this._duration);
    this.onTime(0);
    this.onPlayingChange(false);
  }

  private buildShifter(startSec: number) {
    const ctx = this.ensureCtx();
    if (!this.buffer) return;
    const shifter = new PitchShifter(ctx, this.buffer, BUFFER_SIZE, () => this.handleEnd());
    shifter.tempo = this._tempo;
    shifter.pitch = 1; // keep the key — slow down only
    if (startSec > 0 && this._duration > 0) {
      shifter.percentagePlayed = Math.min(0.999, startSec / this._duration);
    }
    shifter.on("play", (d) => {
      this._time = d.timePlayed;
      this.onTime(d.timePlayed);
    });
    this.shifter = shifter;
  }

  private teardownShifter() {
    if (!this.shifter) return;
    try {
      this.shifter.disconnect();
    } catch {
      /* ignore */
    }
    try {
      (this.shifter.node as unknown as ScriptProcessorNode).onaudioprocess = null;
    } catch {
      /* ignore */
    }
    this.shifter = null;
  }

  // SoundTouch's onEnd fires on EVERY audioprocess tick once the source is
  // exhausted, so guard against re-entry and stop the node on the first hit.
  private handleEnd() {
    if (this._ended) return;
    this._ended = true;
    this._playing = false;
    this._time = this._duration;
    try {
      this.shifter?.disconnect();
    } catch {
      /* ignore */
    }
    this.onTime(this._duration);
    this.onPlayingChange(false);
    this.onEnded();
  }

  async play(): Promise<void> {
    if (!this.buffer) return;
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    // Replay from the top if we're sitting at (or past) the natural end.
    if (this._ended || this._time >= this._duration - 0.05) this.seek(0);
    if (!this.shifter) this.buildShifter(this._time);
    if (this.shifter && this.gain) {
      this.shifter.connect(this.gain); // connecting the node starts playback
      this._playing = true;
      this.onPlayingChange(true);
    }
  }

  pause() {
    if (!this.shifter || !this._playing) return;
    try {
      this.shifter.disconnect(); // disconnecting the node halts playback in place
    } catch {
      /* ignore */
    }
    this._playing = false;
    this.onPlayingChange(false);
  }

  toggle() {
    if (this._playing) this.pause();
    else void this.play();
  }

  seek(seconds: number) {
    const clamped = Math.min(this._duration || 0, Math.max(0, seconds));
    this._time = clamped;
    this._ended = false;
    if (this.shifter && this._duration > 0) {
      this.shifter.percentagePlayed = clamped / this._duration; // setter wants 0..1
    }
    this.onTime(clamped);
  }

  setTempo(tempo: number) {
    this._tempo = tempo;
    if (this.shifter) this.shifter.tempo = tempo; // takes effect live
  }

  setVolume(volume: number) {
    this._volume = Math.min(1, Math.max(0, volume));
    if (this.gain) this.gain.gain.value = this._volume;
  }

  destroy() {
    this.teardownShifter();
    this.buffer = null;
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.gain = null;
    }
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}
