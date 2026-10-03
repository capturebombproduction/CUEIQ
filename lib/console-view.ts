// Live Mode's CONSOLE view (phase B, components/live/console-board.tsx): the DAW-style board
// พี่ picked in round 3 - transport readouts, the show as an arrangement of clips, the item on
// now as a clip editor, a set mixer. A second WAY OF LOOKING at the same show: it reads Live's
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

// ── THE ARRANGEMENT ──────────────────────────────────────────────────────────────────────
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

/** The arrangement shows this much of the show at a time (or all of it, when shorter). */
export const ARRANGEMENT_SPAN = 1200;
/** ... with the playhead this far in, so what comes next has the room. */
export const ARRANGEMENT_LEAD = 0.2;

/** The visible window: `span` seconds following the playhead, held inside the show. */
export function arrangementWindow(
  playhead: number,
  total: number,
  span = ARRANGEMENT_SPAN,
  lead = ARRANGEMENT_LEAD
): { start: number; span: number } {
  if (!(total > 0)) return { start: 0, span: 1 };
  const s = Math.min(span, total);
  return { start: clamp(playhead - s * lead, 0, total - s), span: s };
}

/** A stretch of the show [from, from + len) as left / width percent of the window, or null if outside. */
export function inWindow(from: number, len: number, win: { start: number; span: number }): { left: number; width: number } | null {
  const a = Math.max(from, win.start);
  const b = Math.min(from + len, win.start + win.span);
  if (!(b > a)) return null;
  return { left: ((a - win.start) / win.span) * 100, width: ((b - a) / win.span) * 100 };
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

// ── THE CLIP EDITOR ──────────────────────────────────────────────────────────────────────
/**
 * Bar lines every `every` bars, in BLOCK seconds: the first downbeat is the song's analysed
 * beat_offset (seconds into its audio), the audio starts `audioStart` into the block. Bars
 * are 4/4 (what lib/bpm-detect.ts and the practice metronome assume).
 */
export function barLines(
  bpm: number | null,
  offset: number | null,
  audioStart: number,
  audioLen: number,
  every = 4
): { at: number; bar: number }[] {
  if (bpm == null || offset == null || !(bpm > 0) || !(audioLen > 0) || !Number.isFinite(offset) || !(every >= 1)) return [];
  const barLen = 240 / bpm;
  const out: { at: number; bar: number }[] = [];
  for (let b = 0; offset + b * barLen < audioLen && out.length < 512; b += every) {
    if (offset + b * barLen >= 0) out.push({ at: audioStart + offset + b * barLen, bar: b + 1 });
  }
  return out;
}

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
