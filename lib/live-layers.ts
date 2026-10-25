// SET MIXER's pads (พี่ 2026-10-24: "กดเล่นตามเพลงที่เหลือได้ไหม แล้วก็กดเล่นซ้อนได้ แบบ mix go 16
// … บังคับว่าต้องอยู่โหมดแมนนวล"). In MANUAL the operator fires any row from its pad on CONSOLE,
// and what was sounding is NOT cut: it plays on UNDER the new row, to its own end. Each such
// sound is a LAYER - one of Live's own audio elements that is no longer the primary (the row on
// now, components/event/live-mode.tsx audioRef). This class keeps the layers and their fades;
// Live keeps the elements and which one is the primary.
//
// Every fade here is Auto Mute's: 3 s on lib/fade.ts's fader curve (พี่: "ให้เท่ากับตอนกด auto
// mute หรือ auto LOUD มันคือช่วงเวลาที่สมูทสุดละ"). Where the volume cannot be set (iPhone / iPad)
// a layer stops at once instead of pretending to fade.
//
// A layer's level is its own element's: it keeps what it had when it went under and changes only
// when someone moves it (its tile fader, Auto Mute, its fade) - never because the row's saved
// level changes behind it (a duck given back when the row stops being the primary).

import { fadeLevel, nextFadeFrame } from "@/lib/fade";

/** Sounding at once, the row on now included; a fifth pad fades the oldest out. */
export const PAD_MAX_SOUNDING = 4;
/** Every fade-out a pad makes: Auto Mute's (live-mode.tsx autoMute → fadeKey(0, 3000)). */
export const PAD_FADE_MS = 3000;
/** A second tap this soon after a pad started is a double-click, not "stop it". */
export const PAD_SETTLE_MS = 500;

export interface Layer {
  readonly el: HTMLMediaElement;
  readonly itemId: string;
  /** wall-clock ms at which its file stood at 0:00 - elapsed is now − anchor */
  readonly anchor: number;
  /** the file's length in seconds (0 = unknown) */
  readonly total: number;
  /** when its pad was pressed, ms (0 = it came in some other way) - the double-click guard */
  readonly firedAt: number;
  /** its level 0-100 as it sounds */
  level: number;
  /** when it began to fade out, ms; null while it sounds */
  fadeAt: number | null;
}

export type NewLayer = Omit<Layer, "fadeAt">;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class LiveLayers {
  private layers: Layer[] = [];
  private cancels = new Map<Layer, () => void>();

  constructor(
    private readonly opts: {
      /** a layer came, went, or started to fade (not on every fade frame) */
      onChange: () => void;
      /** false where an element's volume cannot be set: a fade is then a stop */
      canFade: () => boolean;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  list(): readonly Layer[] {
    return this.layers;
  }

  holds(el: HTMLMediaElement | null | undefined): boolean {
    return !!el && this.layers.some((l) => l.el === el);
  }

  /** The layer sounding this row, if one is. */
  of(itemId: string): Layer | undefined {
    return this.layers.find((l) => l.itemId === itemId);
  }

  /** An element goes under. One element is one layer: adding it again changes nothing. */
  add(layer: NewLayer): Layer {
    const had = this.layers.find((l) => l.el === layer.el);
    if (had) return had;
    const l: Layer = { ...layer, level: Math.min(100, Math.max(0, layer.level)), fadeAt: null };
    this.layers.push(l);
    this.opts.onChange();
    return l;
  }

  /** Fade a layer out (Auto Mute's 3 s), then stop it. A layer already fading keeps its fade. */
  fadeOut(l: Layer, ms = PAD_FADE_MS): void {
    if (!this.layers.includes(l) || l.fadeAt != null) return;
    if (ms <= 0 || !this.opts.canFade()) {
      this.stop(l);
      return;
    }
    l.fadeAt = this.now();
    const from = clamp01(l.el.volume) * 100;
    const t0 = performance.now();
    const step = (t: number) => {
      if (!this.layers.includes(l)) return;
      const p = clamp01((t - t0) / ms);
      l.el.volume = clamp01(fadeLevel(from, 0, p) / 100);
      if (p < 1) this.cancels.set(l, nextFadeFrame(step));
      else this.stop(l);
    };
    this.cancels.set(l, nextFadeFrame(step));
    this.opts.onChange();
  }

  /** Every layer fades out - Auto Mute, which is how a show ends. */
  fadeAll(ms = PAD_FADE_MS): void {
    for (const l of [...this.layers]) this.fadeOut(l, ms);
  }

  /** Stop a layer now. */
  stop(l: Layer): void {
    if (!this.drop(l)) return;
    pauseQuietly(l.el);
    this.opts.onChange();
  }

  /** The element is done by itself (its file ended, or it failed): it is no layer any more. */
  release(el: HTMLMediaElement): void {
    const l = this.layers.find((x) => x.el === el);
    if (l && this.drop(l)) this.opts.onChange();
  }

  /** Every layer stops now: a pause, จบโชว์, a reset, a page that became a viewer. */
  quiet(): void {
    if (this.layers.length === 0) return;
    for (const l of [...this.layers]) {
      this.drop(l);
      pauseQuietly(l.el);
    }
    this.opts.onChange();
  }

  /** The page is going away: every layer stops, and nobody is told (there is nobody left). */
  dispose(): void {
    for (const l of [...this.layers]) {
      this.drop(l);
      pauseQuietly(l.el);
    }
  }

  /** Its tile fader: the row's layers that still sound take the level (a fading one keeps fading). */
  setLevel(itemId: string, level: number): void {
    const v = Math.min(100, Math.max(0, level));
    let moved = false;
    for (const l of this.layers) {
      if (l.itemId !== itemId || l.fadeAt != null) continue;
      l.level = v;
      l.el.volume = clamp01(v / 100);
      moved = true;
    }
    if (moved) this.opts.onChange();
  }

  private drop(l: Layer): boolean {
    const i = this.layers.indexOf(l);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    this.cancels.get(l)?.();
    this.cancels.delete(l);
    return true;
  }
}

function pauseQuietly(el: HTMLMediaElement) {
  try {
    if (!el.paused) el.pause();
  } catch {
    /* an element that cannot pause is one that is not playing */
  }
}

/**
 * The layers a new row pushes out: beyond `room` still sounding, the oldest (the one whose file
 * started first). A layer already fading is on its way out and takes no room.
 */
export function crowdedOut(layers: readonly Layer[], room: number): Layer[] {
  const sounding = layers.filter((l) => l.fadeAt == null).sort((a, b) => a.anchor - b.anchor);
  return sounding.slice(0, Math.max(0, sounding.length - Math.max(0, room)));
}
