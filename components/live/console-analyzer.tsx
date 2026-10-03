"use client";

// CONSOLE's ANALYZER and SPECTROGRAM tabs (phase B2): the spectrum in third octaves, the stereo
// picture (goniometer + phase correlation) and the loudness of what this machine is sending,
// live - momentary, short-term, the song's integrated value, its loudness range, the sample
// peak, and a minute of history against the −14 LUFS line. The SPECTROGRAM is the same spectrum
// scrolling through time.
//
// Desktop app only (it needs the SignalTap). The tap's analysis graph is built when this panel
// mounts and torn down when it unmounts, so a CONSOLE on another tab, or STAGE, pays nothing.
// Everything moves through one requestAnimationFrame loop drawing into canvases and writing
// text onto nodes; React renders this once per tab switch.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SignalTap } from "@/lib/live-signal";
import {
  bandLevels,
  correlation,
  gonioPoints,
  LoudnessMeter,
  spectrumPos,
  SPECTRUM_FLOOR_DB,
  THIRD_OCTAVES,
  type AnalysisFrame,
  type LoudnessReading,
} from "@/lib/live-analyzer";
import { LOUDNESS_TARGET } from "@/lib/console-view";

/** The history strip's scale: −40 LUFS at the bottom, −4 at the top (−14 sits at 2/3 up). */
const HIST_LO = -40;
const HIST_HI = -4;
const histPos = (lufs: number) => (Number.isFinite(lufs) ? Math.max(0, Math.min(1, (lufs - HIST_LO) / (HIST_HI - HIST_LO))) : 0);
/** The spectrum's peak marks hold this long, then fall. */
const PEAK_HOLD_MS = 900;
const PEAK_FALL_DB_PER_S = 24;
/** The spectrogram's speed, pixels (CSS) per second. */
const SPECTRO_PX_PER_S = 60;
const FREQ_LABELS: [number, string][] = [
  [31.5, "31"],
  [63, "63"],
  [125, "125"],
  [250, "250"],
  [500, "500"],
  [1000, "1k"],
  [2000, "2k"],
  [4000, "4k"],
  [8000, "8k"],
  [16000, "16k"],
];
const fmtLufs = (v: number | null) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(1).replace("-", "−"));

/** A theme token ("142 71% 45%") as an rgb triple, for canvases (which cannot read var()). */
function tokenRgb(el: Element, name: string): [number, number, number] {
  const raw = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  const m = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(raw);
  if (!m) return [128, 128, 128];
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(v * 255);
  };
  return s === 0 ? [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)] : [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}
const rgb = ([r, g, b]: [number, number, number], a = 1) => `rgba(${r},${g},${b},${a})`;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Keep a canvas's backing store at its CSS size × the device pixel ratio. */
function fit(c: HTMLCanvasElement | null): { w: number; h: number; dpr: number } | null {
  if (!c) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return null;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

export function ConsoleAnalyzer({
  tap,
  trackKey,
  view,
}: {
  tap: SignalTap;
  /** the sounding item; a change starts the integrated value and the peak over */
  trackKey: string | null;
  view: "analyzer" | "spectrogram";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const gonioRef = useRef<HTMLCanvasElement>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const spectroRef = useRef<HTMLCanvasElement>(null);
  const corrRef = useRef<HTMLSpanElement>(null);
  const corrText = useRef<HTMLSpanElement>(null);
  const mRef = useRef<HTMLSpanElement>(null);
  const sRef = useRef<HTMLSpanElement>(null);
  const iRef = useRef<HTMLSpanElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const lraRef = useRef<HTMLSpanElement>(null);
  const live = useRef({ trackKey, view });
  live.current = { trackKey, view };

  useEffect(() => {
    const source = tap.startAnalysis();
    if (!source) return;
    const meter = new LoudnessMeter();
    let lastTrack: string | null | undefined;
    let raf = 0;
    let lastFrame = performance.now();
    let spectroCarry = 0;
    const peaks = THIRD_OCTAVES.map(() => ({ db: -Infinity, at: 0 }));
    let colors: Record<string, [number, number, number]> | null = null;
    let colorsAt = -Infinity;
    let reading: LoudnessReading | null = null;
    const setText = (el: HTMLElement | null, t: string) => {
      if (el && el.textContent !== t) el.textContent = t;
    };

    const drawSpectrum = (bands: number[], now: number, dt: number) => {
      const c = specRef.current;
      const box = fit(c);
      if (!c || !box || !colors) return;
      const g = c.getContext("2d");
      if (!g) return;
      const { w, h, dpr } = box;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // grid every 12 dB
      g.strokeStyle = rgb(colors.fg, 0.07);
      g.lineWidth = 1;
      for (let db = 0; db >= SPECTRUM_FLOOR_DB; db -= 12) {
        const y = Math.round((1 - spectrumPos(db)) * h) + 0.5;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }
      const n = bands.length;
      const slot = w / n;
      const bw = Math.max(1, slot - 2);
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, rgb(colors.success, 0.85));
      grad.addColorStop(0.62, rgb(colors.success, 0.85));
      grad.addColorStop(0.82, rgb(colors.warning, 0.9));
      grad.addColorStop(1, rgb(colors.destructive, 1));
      g.fillStyle = grad;
      const tops: [number, number][] = [];
      bands.forEach((db, i) => {
        const pos = spectrumPos(db);
        const x = i * slot + 1;
        const bh = pos * h;
        g.fillRect(x, h - bh, bw, bh);
        tops.push([x + bw / 2, h - bh]);
        const p = peaks[i];
        if (db >= p.db || now - p.at > PEAK_HOLD_MS) {
          if (db >= p.db) {
            p.db = db;
            p.at = now;
          } else p.db = Math.max(db, p.db - (PEAK_FALL_DB_PER_S * dt) / 1000);
        }
      });
      g.fillStyle = rgb(colors.fg, 0.95);
      peaks.forEach((p, i) => {
        const pos = spectrumPos(p.db);
        if (pos <= 0) return;
        g.fillRect(i * slot + 1, Math.round((1 - pos) * h), bw, 2);
      });
      // the smooth curve over the bar tops
      g.strokeStyle = rgb(colors.fg, 0.85);
      g.lineWidth = 1.5;
      g.beginPath();
      tops.forEach(([x, y], i) => {
        if (i === 0) g.moveTo(x, y);
        else {
          const [px, py] = tops[i - 1];
          const mx = (px + x) / 2;
          g.quadraticCurveTo(px, py, mx, (py + y) / 2);
          if (i === tops.length - 1) g.lineTo(x, y);
        }
      });
      g.stroke();
    };

    const drawGonio = (f: AnalysisFrame) => {
      const c = gonioRef.current;
      const box = fit(c);
      if (!c || !box || !colors) return;
      const g = c.getContext("2d");
      if (!g) return;
      const { w, h, dpr } = box;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // a short afterglow: fade what was there instead of clearing it
      g.fillStyle = rgb(colors.bg, 0.35);
      g.fillRect(0, 0, w, h);
      g.strokeStyle = rgb(colors.fg, 0.12);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w / 2, h);
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.moveTo(0, 0);
      g.lineTo(w, h);
      g.moveTo(w, 0);
      g.lineTo(0, h);
      g.stroke();
      g.fillStyle = rgb(colors.success, 0.75);
      const r = Math.min(w, h) / 2;
      for (const p of gonioPoints(f.left, f.right, 4)) g.fillRect(w / 2 + p.x * r - 1, h / 2 - p.y * r - 1, 2, 2);
      const k = correlation(f.left, f.right);
      if (corrRef.current) corrRef.current.style.left = `${((k + 1) / 2) * 100}%`;
      setText(corrText.current, (k >= 0 ? "+" : "−") + Math.abs(k).toFixed(2));
    };

    const drawHistory = (r: LoudnessReading) => {
      const c = histRef.current;
      const box = fit(c);
      if (!c || !box || !colors) return;
      const g = c.getContext("2d");
      if (!g) return;
      const { w, h, dpr } = box;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const n = r.history.length;
      const slot = w / Math.max(1, n);
      r.history.forEach((v, i) => {
        const pos = histPos(v);
        if (pos <= 0) return;
        g.fillStyle = v > LOUDNESS_TARGET + 1 ? rgb(colors!.warning, 0.85) : rgb(colors!.success, 0.7);
        g.fillRect(i * slot, h - pos * h, Math.max(1, slot - 1), pos * h);
      });
      const y = Math.round((1 - histPos(LOUDNESS_TARGET)) * h) + 0.5;
      g.strokeStyle = rgb(colors.warning, 0.9);
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      g.setLineDash([]);
    };

    const drawSpectrogram = (f: AnalysisFrame, dt: number) => {
      const c = spectroRef.current;
      const box = fit(c);
      if (!c || !box || !colors) return;
      const g = c.getContext("2d");
      if (!g) return;
      const { h, dpr } = box;
      spectroCarry += (SPECTRO_PX_PER_S * dt) / 1000;
      const dx = Math.floor(spectroCarry);
      if (dx < 1) return;
      spectroCarry -= dx;
      const W = c.width;
      const H = c.height;
      const shift = Math.round(dx * dpr);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(c, -shift, 0);
      // the new column: log-spaced rows from 20 Hz (bottom) to 20 kHz (top)
      const rows = Math.max(16, Math.round(h / 3));
      const n = f.bins.length;
      const hzPerBin = f.sampleRate / 2 / n;
      const rowH = H / rows;
      for (let k = 0; k < rows; k++) {
        const lo = 20 * Math.pow(1000, k / rows);
        const hi = 20 * Math.pow(1000, (k + 1) / rows);
        let db = -Infinity;
        for (let i = Math.max(0, Math.floor(lo / hzPerBin)); i <= Math.min(n - 1, Math.ceil(hi / hzPerBin)); i++) db = Math.max(db, f.bins[i]);
        const t = spectrumPos(db);
        const col =
          t < 0.4 ? mix(colors.bg, colors.primary, t / 0.4) : t < 0.75 ? mix(colors.primary, colors.warning, (t - 0.4) / 0.35) : mix(colors.warning, colors.fg, (t - 0.75) / 0.25);
        g.fillStyle = rgb(col);
        g.fillRect(W - shift, H - (k + 1) * rowH, shift, Math.ceil(rowH));
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(250, Math.max(0, now - lastFrame));
      lastFrame = now;
      const root = rootRef.current;
      // nothing to draw into: the panel is off screen (a short stage hides it). checkVisibility
      // is Chromium's (the desktop app); without it, draw.
      if (!root || (root as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility?.() === false) return;
      if (!colors || now - colorsAt > 1000) {
        colors = {
          fg: tokenRgb(root, "foreground"),
          bg: tokenRgb(root, "background"),
          success: tokenRgb(root, "success"),
          warning: tokenRgb(root, "warning"),
          destructive: tokenRgb(root, "destructive"),
          primary: tokenRgb(root, "primary"),
        };
        colorsAt = now;
      }
      const p = live.current;
      if (p.trackKey !== lastTrack) {
        lastTrack = p.trackKey;
        meter.reset();
        peaks.forEach((x) => (x.db = -Infinity));
      }
      const f = source.read();
      if (!f) return;
      reading = meter.push(now, f.kMeanSquare, f.peak);
      if (p.view === "spectrogram") {
        drawSpectrogram(f, dt);
        return;
      }
      drawSpectrum(bandLevels(f.bins, f.sampleRate), now, dt);
      drawGonio(f);
      drawHistory(reading);
      setText(mRef.current, fmtLufs(reading.momentary));
      setText(sRef.current, fmtLufs(reading.shortTerm));
      setText(iRef.current, fmtLufs(reading.integrated));
      setText(peakRef.current, Number.isFinite(reading.peak) ? `${fmtLufs(reading.peak)} dBFS` : "—");
      setText(lraRef.current, reading.lra == null ? "—" : `${reading.lra.toFixed(1)} LU`);
      if (iRef.current) iRef.current.dataset.over = reading.integrated != null && reading.integrated > LOUDNESS_TARGET + 1 ? "1" : "0";
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      source.stop();
    };
  }, [tap]);

  return (
    <div ref={rootRef} data-testid="console-analyzer" className="min-h-0 flex-1">
      {view === "spectrogram" ? (
        <div className="grid h-full min-h-0 grid-cols-[34px_minmax(0,1fr)] gap-1 p-2">
          {/* log rows, 20 Hz (bottom) to 20 kHz (top): a label sits at log(f / 20) / log(1000) */}
          <div className="relative mb-[18px]">
            {[
              ["20k", 0],
              ["5k", 20.1],
              ["1k", 43.4],
              ["200", 66.7],
              ["20", 100],
            ].map(([label, top]) => (
              <span
                key={label}
                className="num absolute right-0 -translate-y-1/2 text-[10.5px] font-semibold text-muted-foreground"
                style={{ top: `${top}%` }}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="flex min-h-0 flex-col gap-0.5">
            <canvas ref={spectroRef} aria-label="สเปกโตรแกรมของเสียงที่ส่งออก" className="block min-h-0 w-full flex-1 bg-background" />
            <div className="num flex justify-between text-[10.5px] font-semibold text-muted-foreground">
              <span>ย้อนหลัง</span>
              <span>เวลา →</span>
              <span>ตอนนี้</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(150px,196px)_minmax(190px,232px)] gap-2 p-2">
          <div className="grid min-h-0 min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-1">
            <div className="relative mb-4">
              {[0, -24, -48, -72].map((db) => (
                <span
                  key={db}
                  className="num absolute right-0 -translate-y-1/2 text-[10px] font-semibold text-faint"
                  style={{ top: `${(1 - spectrumPos(db)) * 100}%` }}
                >
                  {db === 0 ? "0" : `−${-db}`}
                </span>
              ))}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col">
              <canvas ref={specRef} aria-label="สเปกตรัม 1/3 อ็อกเทฟของเสียงที่ส่งออก" className="block min-h-0 w-full flex-1" />
              <div className="relative h-4 shrink-0">
                {FREQ_LABELS.map(([hz, label]) => (
                  <span
                    key={label}
                    className="num absolute top-0.5 -translate-x-1/2 text-[10.5px] font-semibold text-muted-foreground"
                    style={{ left: `${((THIRD_OCTAVES.indexOf(hz) + 0.5) / THIRD_OCTAVES.length) * 100}%` }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col items-center gap-1.5">
            {/* a square as tall as the column allows (narrower if the column is) */}
            <div className="relative min-h-0 w-full flex-1">
              <div className="absolute inset-y-0 left-1/2 aspect-square max-w-full -translate-x-1/2 bg-background shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                <canvas ref={gonioRef} aria-label="โกนิโอมิเตอร์ (ภาพสเตอริโอ)" className="absolute inset-0 block size-full" />
                <span className="num absolute left-1.5 top-1 text-[10px] text-faint">L</span>
                <span className="num absolute left-1/2 top-1 -translate-x-1/2 text-[10px] text-faint">M</span>
                <span className="num absolute right-1.5 top-1 text-[10px] text-faint">R</span>
              </div>
            </div>
            <div className="w-full shrink-0">
              <div className="num flex justify-between text-[10.5px] font-semibold text-muted-foreground">
                <span>−1</span>
                <span>
                  CORRELATION <span ref={corrText} className="text-foreground">—</span>
                </span>
                <span>+1</span>
              </div>
              <div className="relative mt-0.5 h-1.5 bg-[linear-gradient(90deg,hsl(var(--destructive))_0%,hsl(var(--muted))_50%,hsl(var(--success))_100%)]">
                <span ref={corrRef} className="absolute -inset-y-[3px] left-1/2 w-[3px] -translate-x-1/2 bg-foreground" />
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="grid shrink-0 grid-cols-3 gap-1">
              {(
                [
                  ["Momentary", mRef],
                  ["Short", sRef],
                  ["Integrated", iRef],
                ] as const
              ).map(([label, ref]) => (
                <div key={label} className="bg-background px-1.5 py-1 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                  <div className="en truncate text-[9.5px] tracking-[.06em] text-muted-foreground">{label}</div>
                  <span
                    ref={ref}
                    data-testid={`console-lufs-${label.toLowerCase()}`}
                    className={cn("num block text-[21px] leading-none", label === "Integrated" && "data-[over='1']:text-warning-ink")}
                  >
                    —
                  </span>
                </div>
              ))}
            </div>
            <div className="relative min-h-0 flex-1 bg-background shadow-[inset_0_0_0_1px_hsl(var(--border))]">
              <canvas ref={histRef} aria-label="ความดังย้อนหลัง 60 วินาที" className="absolute inset-0 block size-full" />
              <span className="absolute left-1 top-0.5 text-[10px] text-faint">60 วินาทีล่าสุด</span>
              <span
                className="num absolute right-1 text-[10px] text-warning-ink"
                style={{ bottom: `calc(${histPos(LOUDNESS_TARGET) * 100}% + 1px)` }}
              >
                −14
              </span>
            </div>
            <div className="num flex shrink-0 justify-between gap-2 text-[12px] text-muted-foreground">
              <span title="พีกของตัวอย่างเสียง (ไม่ใช่ true peak แบบ oversample)">
                PEAK <span ref={peakRef} className="text-foreground">—</span>
              </span>
              <span title="ช่วงความดัง (EBU Tech 3342) ของเพลงนี้">
                LRA <span ref={lraRef} className="text-foreground">—</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
