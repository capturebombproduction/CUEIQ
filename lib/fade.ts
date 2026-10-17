// The path a volume fade takes, and the clock it runs on - shared by Live Mode
// (components/event/live-mode.tsx) and Quick Show (desktop/src/pages/my-show.tsx): their fade
// keys, a Loop row's end-fade and a crossfade's outgoing track.
//
// A level (0-100) is the element's volume - linear amplitude, what the slider shows and what
// a soundcheck saves. That stays. The PATH between two levels was a straight line in it, which
// sounds loud for most of a fade and then falls off a cliff: half way through an Auto Mute
// from 100 it was still at 50 % (-6 dB), and its last tenth fell from -20 dB to nothing. It
// also wrote whole percents, so the tail stepped 3 → 2 → 1 → 0 % (-3.5 dB, -6 dB, silence).
// A fade now moves evenly along a cube-law fader (position = level^(1/3), an audio fader's
// taper): half way out it is near -18 dB, it lands without a step, and the element is given
// the exact value - a percent is rounded for the screen only.

const pct = (v: number) => Math.min(100, Math.max(0, v));

/** Where a fade from `from` to `to` (percent) stands at `p` (0..1) of its way - percent, unrounded. */
export function fadeLevel(from: number, to: number, p: number): number {
  if (p >= 1) return pct(to);
  const a = Math.cbrt(pct(from) / 100);
  const b = Math.cbrt(pct(to) / 100);
  const pos = a + (b - a) * Math.max(0, p);
  return 100 * pos * pos * pos;
}

/** How long a fade waits for a frame before it steps anyway. */
export const FADE_FALLBACK_MS = 50;

/**
 * Call `step` on the next frame - or after FADE_FALLBACK_MS when no frame comes. Fades rode
 * requestAnimationFrame alone, and a hidden page draws no frames (measured in Electron 42:
 * a minimized window ran ONE frame in 4 s, music playing or not). An Auto Mute pressed and
 * then minimized - or a browser tab switched away from - froze mid-fade, and the music played
 * on at that level until the window came back. `step` gets a performance.now() time either
 * way. Returns a cancel.
 */
export function nextFadeFrame(step: (t: number) => void): () => void {
  let done = false;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
  const run = (t: number) => {
    if (done) return;
    stop();
    step(t);
  };
  raf = requestAnimationFrame(run);
  if (!done) timer = setTimeout(() => run(performance.now()), FADE_FALLBACK_MS);
  return stop;
}
