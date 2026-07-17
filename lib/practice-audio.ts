// ---------------------------------------------------------------------------
// Practice Mode audio engine — high-quality, pitch-preserving slow-down.
//
// HYBRID, two backends behind one interface:
//
//   • "native"  — a plain HTMLAudioElement at playbackRate 1. Used whenever the
//     speed is 1×. Streams the blob, starts instantly, costs almost no memory.
//     This is the common case (practising at full speed), so it pays nothing.
//
//   • "stretch" — SoundTouchJS (WSOLA) running through the Web Audio graph. Used
//     only at <1× (0.75 / 0.5). It needs the whole song decoded into an
//     AudioBuffer, which it CAN'T stream — so we decode lazily, the first time
//     the user actually slows a given song down. Native preservesPitch is low
//     quality on iOS Safari (and ignored on some versions — the key drops);
//     SoundTouch behaves identically everywhere, including iOS.
//
// So a big WAV that's only ever played at full speed is never decoded; the
// decode cost (and the spinner for it, via onPreparing) is paid only on the
// first slow-down. The decoded buffer is cached for the loaded song, so toggling
// speed back and forth doesn't re-decode. Only one song is in memory at a time.
//
// The player talks ONLY to this class. Slow-down is Practice-Mode-only — Live
// Mode never uses this.
// ---------------------------------------------------------------------------

import type { PitchShifter } from "soundtouchjs";

// SoundTouch drives playback through a ScriptProcessorNode whose callback fires
// every BUFFER_SIZE / sampleRate seconds (~93ms at 44.1kHz). Smaller = tighter
// A-B loop / scrubber updates, at a little more CPU. 4096 is the library default.
const BUFFER_SIZE = 4096;

// SoundTouchJS is only needed for slow-down (<1× = the "stretch" backend). The
// common case — practising at full speed — never touches it, so we lazy-load the
// library the first time a slow-down is requested instead of bundling it into the
// practice route up front. The constructor promise is module-level so it loads at
// most once across every engine instance.
type PitchShifterCtor = new (
  context: AudioContext,
  buffer: AudioBuffer,
  bufferSize: number,
  onEnd?: () => void
) => PitchShifter;
let _shifterCtor: PitchShifterCtor | null = null;
async function loadShifterCtor(): Promise<PitchShifterCtor> {
  if (!_shifterCtor) {
    const m = await import("soundtouchjs");
    _shifterCtor = m.PitchShifter as unknown as PitchShifterCtor;
  }
  return _shifterCtor;
}

type Backend = "native" | "stretch";

export class PracticeAudioEngine {
  // shared state (kept consistent across both backends)
  private _tempo = 1; // 1 = native, <1 = stretch
  private _volume = 1; // 0..1
  private _playing = false;
  private _duration = 0;
  private _time = 0;
  private active: Backend = "native";

  // native backend
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;

  // stretch backend (lazy)
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private shifter: PitchShifter | null = null;
  private shifterCtor: PitchShifterCtor | null = null; // lazily loaded on first slow-down
  private buffer: AudioBuffer | null = null;
  private blob: Blob | null = null; // kept so we can decode on the first slow-down
  private _ended = false;
  private _kicked = false; // has the iOS silent-buffer unlock run?
  private switching = false; // serialises backend switches across rapid toggles
  // Bumped by load()/destroy(). Decodes are slow and can't be cancelled, so every
  // in-flight decode captures this before awaiting and DROPS its result if a new
  // song took over meanwhile — otherwise a late decode of the previous song would
  // be cached (and played) as the current one.
  private loadGen = 0;

  // The player assigns these; defaults are no-ops so the engine is safe pre-wiring.
  onTime: (seconds: number) => void = () => {};
  onDuration: (seconds: number) => void = () => {};
  onPlayingChange: (playing: boolean) => void = () => {};
  onEnded: () => void = () => {};
  onPreparing: (preparing: boolean) => void = () => {}; // decoding for slow-down

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

  // --- native element -------------------------------------------------------

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const a = new Audio();
      a.preload = "auto";
      a.volume = this._volume;
      a.addEventListener("timeupdate", () => {
        if (this.active !== "native") return;
        this._time = a.currentTime;
        this.onTime(a.currentTime);
      });
      a.addEventListener("loadedmetadata", () => {
        if (this.active !== "native") return;
        this._duration = a.duration;
        this.onDuration(a.duration);
      });
      a.addEventListener("play", () => {
        if (this.active !== "native") return;
        this._playing = true;
        this.onPlayingChange(true);
      });
      a.addEventListener("pause", () => {
        if (this.active !== "native") return;
        this._playing = false;
        this.onPlayingChange(false);
      });
      a.addEventListener("ended", () => {
        if (this.active !== "native") return;
        this._playing = false;
        this.onPlayingChange(false);
        this.onEnded();
      });
      this.audio = a;
    }
    return this.audio;
  }

  private setNativeTime(a: HTMLAudioElement, t: number) {
    if (a.readyState >= 1 /* HAVE_METADATA */) {
      try {
        a.currentTime = t;
      } catch {
        /* not seekable yet */
      }
    } else {
      const onMeta = () => {
        try {
          a.currentTime = t;
        } catch {
          /* ignore */
        }
        a.removeEventListener("loadedmetadata", onMeta);
      };
      a.addEventListener("loadedmetadata", onMeta);
    }
  }

  // --- Web Audio / stretch --------------------------------------------------

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
   * Unlock audio. Call SYNCHRONOUSLY from inside a user gesture (the tap that
   * starts playback / changes speed). iOS Safari only lets an AudioContext start
   * — and only honours a silent-buffer "kick" — from within a gesture, so doing
   * it here keeps the context running through the later async decode/play.
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
        /* best-effort */
      }
    }
  }

  private decode(ctx: AudioContext, arr: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
      // Promise form is standard; passing callbacks too keeps older Safari happy.
      const ret = ctx.decodeAudioData(arr, resolve, reject) as unknown as
        | Promise<AudioBuffer>
        | undefined;
      if (ret && typeof ret.then === "function") ret.then(resolve, reject);
    });
  }

  /** Decode the current blob (once) and build the shifter armed at startSec. */
  private async prepareStretch(startSec: number): Promise<void> {
    const blob = this.blob;
    if (!blob) return;
    const gen = this.loadGen;
    const ctx = this.ensureCtx();
    await ctx.resume().catch(() => {});
    if (gen !== this.loadGen) return; // a new song was loaded meanwhile
    if (!this.buffer) {
      this.onPreparing(true);
      try {
        const arr = await blob.arrayBuffer();
        const decoded = await this.decode(ctx, arr);
        if (gen !== this.loadGen) return; // stale decode — the new load owns the cache
        this.buffer = decoded;
      } finally {
        // a stale run must not clear the spinner the newer load's prepare owns
        if (gen === this.loadGen) this.onPreparing(false);
      }
    }
    this._duration = this.buffer.duration;
    await this.ensureShifterCtor();
    if (gen !== this.loadGen) return;
    this.buildShifter(startSec);
    this.onDuration(this._duration);
    this.onTime(startSec);
  }

  // Load SoundTouchJS (once) so the synchronous buildShifter can construct it.
  private async ensureShifterCtor(): Promise<void> {
    if (!this.shifterCtor) this.shifterCtor = await loadShifterCtor();
  }

  private buildShifter(startSec: number) {
    const ctx = this.ensureCtx();
    if (!this.buffer || !this.shifterCtor) return;
    this.teardownShifter();
    const shifter = new this.shifterCtor(ctx, this.buffer, BUFFER_SIZE, () => this.handleEnd());
    shifter.tempo = this._tempo;
    shifter.pitch = 1; // keep the key — slow down only
    if (startSec > 0 && this._duration > 0) {
      shifter.percentagePlayed = Math.min(0.999, startSec / this._duration);
    }
    shifter.on("play", (d) => {
      if (this.active !== "stretch") return;
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

  // SoundTouch's onEnd fires on EVERY audioprocess tick once exhausted — guard.
  private handleEnd() {
    if (this._ended || this.active !== "stretch") return;
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

  // --- public transport -----------------------------------------------------

  /** Arm a new song. Sets up native streaming immediately; decodes for stretch
   *  only if we're already in a slow tempo (carried over from the last song). */
  async load(blob: Blob): Promise<void> {
    this.loadGen++; // invalidate any decode still in flight for the previous song
    this.teardownShifter();
    this.buffer = null; // force a fresh decode for the new song
    this.blob = blob;
    this._time = 0;
    this._ended = false;
    this._playing = false;

    const a = this.ensureAudio();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    a.src = this.objectUrl;
    a.playbackRate = 1;
    a.load(); // pull metadata so a later switch-to-native can seek immediately

    if (this._tempo < 1) {
      this.active = "stretch";
      await this.prepareStretch(0);
      this.onPlayingChange(false);
    } else {
      this.active = "native";
      this.onTime(0);
      this.onPlayingChange(false);
      // duration arrives via the native loadedmetadata listener
    }
  }

  /** Decode (once) and return the current song's buffer — used for BPM detection.
   *  Shares the cache with the stretch backend so we never decode the same song
   *  twice. Heavy for a big WAV, but it's paid only when the user asks. */
  async getBuffer(): Promise<AudioBuffer | null> {
    if (this.buffer) return this.buffer;
    const blob = this.blob;
    if (!blob) return null;
    const gen = this.loadGen;
    const ctx = this.ensureCtx();
    const arr = await blob.arrayBuffer();
    const decoded = await this.decode(ctx, arr);
    if (gen !== this.loadGen) return null; // song changed mid-decode — don't cache it
    this.buffer = decoded;
    this._duration = decoded.duration;
    return decoded;
  }

  async play(): Promise<void> {
    if (this.active === "native") {
      const a = this.ensureAudio();
      await a.play().catch(() => {}); // 'play' listener flips state
      return;
    }
    // stretch
    if (!this.blob) return;
    if (!this.buffer) await this.prepareStretch(this._time);
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    if (this._ended || this._time >= this._duration - 0.05) this.seek(0);
    if (!this.shifter) {
      await this.ensureShifterCtor();
      this.buildShifter(this._time);
    }
    if (this.shifter && this.gain) {
      this.shifter.connect(this.gain); // connecting the node starts playback
      this._playing = true;
      this.onPlayingChange(true);
    }
  }

  pause() {
    if (this.active === "native") {
      this.audio?.pause(); // 'pause' listener flips state
      return;
    }
    if (this.shifter && this._playing) {
      try {
        this.shifter.disconnect(); // disconnecting halts playback in place
      } catch {
        /* ignore */
      }
      this._playing = false;
      this.onPlayingChange(false);
    }
  }

  toggle() {
    if (this._playing) this.pause();
    else void this.play();
  }

  seek(seconds: number) {
    const clamped = Math.min(this._duration || 0, Math.max(0, seconds));
    this._time = clamped;
    this._ended = false;
    if (this.active === "native") {
      const a = this.audio;
      if (a) this.setNativeTime(a, clamped);
    } else if (this.shifter && this._duration > 0) {
      this.shifter.percentagePlayed = clamped / this._duration; // setter wants 0..1
    }
    this.onTime(clamped);
  }

  setTempo(tempo: number) {
    const prev = this._tempo;
    this._tempo = tempo;
    if (tempo < 1 && prev < 1) {
      // slow → slow: just retune the running shifter, no backend change
      if (this.shifter) this.shifter.tempo = tempo;
      return;
    }
    if (tempo === 1 && prev === 1) return;
    void this.switchBackend(); // crossing the native <-> stretch boundary
  }

  setVolume(volume: number) {
    this._volume = Math.min(1, Math.max(0, volume));
    if (this.audio) this.audio.volume = this._volume;
    if (this.gain) this.gain.gain.value = this._volume;
  }

  destroy() {
    this.loadGen++; // drop any decode still in flight
    this.teardownShifter();
    this.buffer = null;
    this.blob = null;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        /* ignore */
      }
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
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

  // --- backend switching ----------------------------------------------------

  // Converge `active` to whatever `_tempo` now wants. The while-loop re-reads
  // `_tempo` after each async step so rapid speed toggles during a decode settle
  // on the final choice instead of racing. `switching` keeps it single-flight.
  private async switchBackend(): Promise<void> {
    if (this.switching) return; // an in-flight switch will re-check _tempo at its loop top
    this.switching = true;
    try {
      for (;;) {
        const want: Backend = this._tempo < 1 ? "stretch" : "native";
        if (want === this.active) {
          if (want === "stretch" && this.shifter) this.shifter.tempo = this._tempo;
          break;
        }
        await this.doSwitch(want);
      }
    } finally {
      this.switching = false;
    }
  }

  private async doSwitch(want: Backend): Promise<void> {
    const wasPlaying = this._playing;
    const at = this._time;
    if (want === "stretch") {
      // native → stretch
      if (this.audio && !this.audio.paused) this.audio.pause();
      this.active = "stretch";
      await this.prepareStretch(at);
      if (this.shifter) this.shifter.tempo = this._tempo;
      if (wasPlaying) await this.play();
      else this.onPlayingChange(false);
    } else {
      // stretch → native
      if (this.shifter) {
        try {
          this.shifter.disconnect();
        } catch {
          /* ignore */
        }
      }
      this.active = "native";
      const a = this.ensureAudio();
      a.playbackRate = 1;
      this.setNativeTime(a, at);
      if (a.duration) this._duration = a.duration;
      this.onTime(at);
      if (wasPlaying) await a.play().catch(() => {});
      else this.onPlayingChange(false);
    }
  }
}
