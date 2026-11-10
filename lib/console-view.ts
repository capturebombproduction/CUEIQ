// Live Mode's CONSOLE view (phase B, components/live/console-board.tsx): the DAW-style board
// พี่ picked in round 3 - transport readouts, the show as a timeline of clips with the item on
// now opened into its waveform, a set mixer, an analyzer. A second WAY OF LOOKING at the same show: it reads Live's
// state and never owns any. The audio engine, the clock and the keys stay in live-mode.tsx.
//
// The arithmetic is here, import-free and unit-tested (lib/console-view.test.ts); the board
// only draws what these return.

/** Which board this device shows (per device, like the sound and output choices). */
export type LiveView = "stage" | "console";
export const LIVE_VIEW_KEY = "cueiq:liveView";
/** Anything but an explicit "console" is STAGE: the approved screen stays the default. */
export const readLiveView = (raw: string | null | undefined): LiveView => (raw === "console" ? "console" : "stage");

/**
 * The `stage:` screen of tailwind.preset.ts as a media query. CONSOLE exists only there: a
 * phone, a portrait tablet and a short window keep STAGE whatever this device chose
 * (lib/console-view.test.ts holds the two strings equal).
 */
export const STAGE_MEDIA = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pad2 = (n: number) => String(n).padStart(2, "0");

/** m:ss, for the rulers (an hour-long show reads 61:30, as a DAW ruler does). */
export const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};

// ── THE TIMELINE ─────────────────────────────────────────────────────────────────────────
/** Where each block starts on the show's PLAN timeline, and the planned total. */
export function blockStarts(lengths: readonly number[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let at = 0;
  for (const len of lengths) {
    starts.push(at);
    at += Math.max(0, len || 0);
  }
  return { starts, total: at };
}

/** The clip on NOW takes this share of the strip; the rest of the show shares what is left. */
export const TIMELINE_NOW_SHARE = 0.44;
/** No clip is squeezed under this share: at 1.25 % a one-minute row measured 7-12 px in Chromium
 *  (1024-1440 px windows) - no room for its two-digit number, nothing to aim a tap at. */
export const TIMELINE_MIN_SHARE = 0.02;

/**
 * The TIMELINE's clips as left / width percent of the strip: the whole show in one row, in
 * order, edge to edge. The clip on `now` is widened to `nowShare` (it keeps its own share when
 * that is already more: a two-row show - short of the others' minimum), the others share the
 * rest by their length, and none
 * falls under `minShare` - a 38 s MC in a 70-minute show would be 5 px, a 0:00 row nothing at
 * all. More rows than the minimum has room for share the rest equally. `now` outside the list:
 * every clip by its length.
 */
export function timelineLayout(
  lengths: readonly number[],
  now: number,
  nowShare = TIMELINE_NOW_SHARE,
  minShare = TIMELINE_MIN_SHARE
): { left: number; width: number }[] {
  const n = lengths.length;
  if (n === 0) return [];
  const len = lengths.map((l) => (Number.isFinite(l) && l > 0 ? l : 0));
  const total = len.reduce((a, b) => a + b, 0);
  const hasNow = now >= 0 && now < n;
  const share: number[] = new Array(n).fill(0);
  const others = len.map((_, i) => i).filter((i) => !hasNow || i !== now);
  // its own share when that is more - but never so much that the others lose their minimum
  if (hasNow)
    share[now] = others.length === 0 ? 1 : Math.min(Math.max(nowShare, total > 0 ? len[now] / total : 0), Math.max(nowShare, 1 - others.length * minShare));
  const room = 1 - (hasNow ? share[now] : 0);
  const floor = Math.min(minShare, others.length > 0 ? room / others.length : 0);
  // by length, lifting whoever falls under the floor and sharing what is left among the rest
  const atFloor = new Set<number>();
  for (;;) {
    const free = others.filter((i) => !atFloor.has(i));
    const sum = free.reduce((a, i) => a + len[i], 0);
    const left = room - atFloor.size * floor;
    let lifted = false;
    for (const i of free) {
      const w = sum > 0 ? (len[i] / sum) * left : left / free.length;
      if (w < floor - 1e-12) {
        atFloor.add(i);
        lifted = true;
      } else share[i] = w;
    }
    if (!lifted) break;
  }
  atFloor.forEach((i) => (share[i] = floor));
  let at = 0;
  return share.map((w) => {
    const slot = { left: at * 100, width: w * 100 };
    at += w;
    return slot;
  });
}

/** Ruler marks at a round step that gives at most ten across the window. */
export function rulerMarks(win: { start: number; span: number }): { at: number; pct: number; label: string }[] {
  const steps = [15, 30, 60, 120, 300, 600, 1200, 1800];
  const step = steps.find((s) => win.span / s <= 10) ?? 3600;
  const out: { at: number; pct: number; label: string }[] = [];
  for (let at = Math.ceil(win.start / step) * step; at < win.start + win.span; at += step) {
    out.push({ at, pct: ((at - win.start) / win.span) * 100, label: mmss(at) });
  }
  return out;
}

// ── THE CLIP ON NOW ──────────────────────────────────────────────────────────────────────
/** "17.3": bar and beat (1-based, 4/4) at `t` seconds into the audio, or null before beat one. */
export function barBeat(t: number, bpm: number | null, offset: number | null): string | null {
  if (bpm == null || offset == null || !(bpm > 0) || !Number.isFinite(t) || t < offset) return null;
  const beats = Math.floor(((t - offset) * bpm) / 60);
  return `${Math.floor(beats / 4) + 1}.${(beats % 4) + 1}`;
}

/** The practice room's markers (block seconds) as regions across the block: each runs to the next. */
export function sectionRegions(
  markers: readonly { label: string; at: number }[],
  block: number
): { label: string; start: number; end: number }[] {
  if (!(block > 0)) return [];
  const sorted = markers
    .filter((m) => Number.isFinite(m.at) && m.at < block)
    .slice()
    .sort((a, b) => a.at - b.at);
  return sorted.map((m, i) => ({
    label: m.label,
    start: Math.max(0, m.at),
    end: i + 1 < sorted.length ? Math.max(0, sorted[i + 1].at) : block,
  }));
}

/** A waveform (0-1 levels) squeezed or stretched to `n` columns, each the loudest it covers. */
export function resample(levels: readonly number[], n: number): number[] {
  if (levels.length === 0 || n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * levels.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / n) * levels.length));
    let m = 0;
    for (let k = a; k < b && k < levels.length; k++) m = Math.max(m, levels[k]);
    out.push(m);
  }
  return out;
}

/**
 * An SVG path of mirrored bars (viewBox 0 0 levels.length 100, preserveAspectRatio none): one
 * bar per level, `fill` of its column, at least `floor` tall so a quiet stretch still reads.
 * Only bars [from, to) are drawn, so a played / to-come / last-minute split is three paths
 * over one geometry.
 */
export function waveBars(levels: readonly number[], fill = 0.72, floor = 0.03, from = 0, to = levels.length): string {
  let d = "";
  for (let i = Math.max(0, from); i < Math.min(to, levels.length); i++) {
    const h = Math.max(floor, Math.min(1, levels[i])) * 48;
    const x = i + (1 - fill) / 2;
    d += `M${x.toFixed(2)} ${(50 - h).toFixed(2)}h${fill}v${(2 * h).toFixed(2)}h-${fill}z`;
  }
  return d;
}

// ── THE SET MIXER ────────────────────────────────────────────────────────────────────────
/** The level a set is evened out to (the usual streaming reference). */
export const LOUDNESS_TARGET = -14;

/**
 * How far a song's fader would come DOWN to sit at the target, in dB (0 for a song at or under
 * it: a player's volume tops out at 100 %, so a quiet song cannot be raised). Null = unmeasured.
 */
export function trimFor(lufs: number | null | undefined, target = LOUDNESS_TARGET): number | null {
  if (lufs == null || !Number.isFinite(lufs)) return null;
  const t = Math.min(0, Math.round((target - lufs) * 10) / 10);
  return t === 0 ? 0 : t; // never −0 ("−0.0 dB" on a strip)
}

/** A level change in dB as the player volume (percent of full) that makes it. */
export const dbToVolume = (db: number) => Math.round(100 * Math.pow(10, db / 20));

/** The fader's reading: a volume percent as dB (−Infinity at 0). */
export const volumeToDb = (pct: number) => (pct > 0 ? 20 * Math.log10(pct / 100) : -Infinity);

/** A mixer strip's bar height (0-1) for an integrated loudness: −30 LUFS empty, −6 full. */
export const lufsBar = (lufs: number | null | undefined) =>
  lufs == null || !Number.isFinite(lufs) ? 0 : clamp((lufs + 30) / 24, 0, 1);
