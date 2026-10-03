"use client";

// Live Mode's Signal strip (STAGE, desktop app): two meters of what this machine is sending,
// its peak, a clip light - and the NO SIGNAL watch behind them. The levels come from
// lib/live-signal.ts's SignalTap, a COPY of the players' output (never in the audio path).
//
// The meters move at screen rate without re-rendering Live Mode: one requestAnimationFrame
// loop writes the bars' transforms straight onto their nodes. React only hears about a
// change of verdict (the alarm on / off), through onVerdict.
import { useEffect, useRef, useState } from "react";
import {
  CLIP_LEVEL,
  initialSilence,
  meterPos,
  stepSilence,
  toDb,
  type SignalTap,
  type SilenceVerdict,
} from "@/lib/live-signal";
import { cn } from "@/lib/utils";

/** How long a clip keeps the light on, and a peak its hold mark. */
const CLIP_HOLD_MS = 1500;
const PEAK_HOLD_MS = 1200;

export function SignalStrip({
  tap,
  player,
  sounding,
  trackKey,
  waveform,
  onVerdict,
  className,
}: {
  tap: SignalTap | null;
  /** the primary player: position, length, volume, muted */
  player: () => HTMLMediaElement | null;
  /** this device makes the show's sound and a file is playing */
  sounding: boolean;
  /** the playing track (item + file); a change restarts the watch's grace */
  trackKey: string | null;
  /** the playing song's waveform (lib/song-analysis.ts decodeWaveform), [] if unmeasured */
  waveform: readonly number[];
  onVerdict: (v: SilenceVerdict) => void;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barL = useRef<HTMLSpanElement>(null);
  const barR = useRef<HTMLSpanElement>(null);
  const holdL = useRef<HTMLSpanElement>(null);
  const holdR = useRef<HTMLSpanElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  const clipRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  // the latest props, for the loop (it is started once)
  const live = useRef({ sounding, trackKey, waveform, onVerdict, player });
  live.current = { sounding, trackKey, waveform, onVerdict, player };

  useEffect(() => {
    if (!tap) return;
    let raf = 0;
    let watch = initialSilence();
    let lastVerdict: SilenceVerdict = null;
    let wasReady = false;
    const hold = { l: 0, r: 0, lAt: 0, rAt: 0, clipAt: -Infinity };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const p = live.current;
      const el = p.player();
      const r = tap.read();
      if (r.ready !== wasReady) {
        wasReady = r.ready;
        setReady(r.ready);
      }
      // What leaves the app: the copy is taken before the player's volume, so apply it.
      const gain = el && !el.muted ? el.volume : 0;
      const l = r.rmsL * gain;
      const rr = r.rmsR * gain;
      const pk = Math.max(r.peakL, r.peakR) * gain;
      if (r.peakL * gain > hold.l || now - hold.lAt > PEAK_HOLD_MS) {
        hold.l = r.peakL * gain;
        hold.lAt = now;
      }
      if (r.peakR * gain > hold.r || now - hold.rAt > PEAK_HOLD_MS) {
        hold.r = r.peakR * gain;
        hold.rAt = now;
      }
      if (pk >= CLIP_LEVEL) hold.clipAt = now;
      // RMS bars, peak-hold marks, the readout: transforms and text, no React
      // the lit part is the fixed gradient; a cover anchored right shrinks to reveal it
      if (barL.current) barL.current.style.transform = `scaleX(${1 - meterPos(l)})`;
      if (barR.current) barR.current.style.transform = `scaleX(${1 - meterPos(rr)})`;
      if (holdL.current) holdL.current.style.left = `${meterPos(hold.l) * 100}%`;
      if (holdR.current) holdR.current.style.left = `${meterPos(hold.r) * 100}%`;
      const db = toDb(Math.max(hold.l, hold.r));
      if (dbRef.current) {
        dbRef.current.textContent = !r.ready ? "—" : Number.isFinite(db) && db > -60 ? `${db.toFixed(1)}` : "−∞";
      }
      // the reading as data too: the desktop smoke's audible scenario asserts on it
      if (rootRef.current) rootRef.current.dataset.db = r.ready && Number.isFinite(db) ? db.toFixed(1) : "";
      if (clipRef.current) clipRef.current.dataset.on = now - hold.clipAt < CLIP_HOLD_MS ? "1" : "0";

      // The NO SIGNAL watch runs on the file's own level (pre-volume): a fader pulled down
      // on purpose (AUTO MUTE, MC) is not a fault.
      const t = el?.currentTime ?? 0;
      const d = el && Number.isFinite(el.duration) ? el.duration : 0;
      const wf = p.waveform;
      let expectedQuiet = false;
      if (wf.length > 0 && d > 0) {
        const i = Math.floor((t / d) * wf.length);
        expectedQuiet = [i - 1, i, i + 1].some((k) => k >= 0 && k < wf.length && wf[k] < 0.2);
      }
      const step = stepSilence(watch, {
        now,
        playing: p.sounding && !!el && !el.paused,
        trackKey: p.trackKey,
        tapReady: r.ready,
        rms: Math.max(r.rmsL, r.rmsR),
        currentTime: t,
        duration: d,
        expectedQuiet,
      });
      watch = step.state;
      if (step.verdict !== lastVerdict) {
        lastVerdict = step.verdict;
        p.onVerdict(step.verdict);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (lastVerdict !== null) live.current.onVerdict(null);
    };
  }, [tap]);

  if (!tap) return null;
  return (
    <div
      ref={rootRef}
      data-testid="signal-strip"
      data-ready={ready ? "1" : "0"}
      title={
        ready
          ? "ระดับสัญญาณที่แอปส่งออกจริง (L/R) · ขีดขาว = พีก · CLIP = เสียงแตก — วัดได้ถึงตัวเครื่องเท่านั้น สาย/มิกเซอร์หลังจากนี้ต้องดูที่มิกเซอร์"
          : "มิเตอร์จะทำงานเมื่อกดปุ่มใดก็ได้บนหน้าจอ (ข้อกำหนดของระบบเสียง)"
      }
      className={cn("flex h-11 shrink-0 items-center gap-2.5 rounded-[2px] px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border))]", className)}
    >
      <div className="flex w-[150px] flex-col gap-[5px] xl:w-[190px]">
        {(["L", "R"] as const).map((ch) => (
          <div key={ch} className="flex items-center gap-1.5">
            <span className="num w-2 text-[10.5px] text-muted-foreground">{ch}</span>
            <span className="relative h-2 flex-1 overflow-hidden bg-[linear-gradient(90deg,hsl(var(--success))_0%,hsl(var(--success))_75%,hsl(var(--warning))_87.5%,hsl(var(--destructive))_100%)]">
              {/* the unlit part: a cover anchored right, scaled to what is NOT lit */}
              <span ref={ch === "L" ? barL : barR} className="absolute inset-0 origin-right bg-background/90" />
              <span ref={ch === "L" ? holdL : holdR} className="absolute inset-y-[-1px] left-0 w-[2px] bg-foreground" />
            </span>
          </div>
        ))}
      </div>
      <span ref={dbRef} className="num w-[46px] text-right text-[17px] leading-none">
        —
      </span>
      <span
        ref={clipRef}
        data-on="0"
        className="font-display-x text-[11px] font-extrabold uppercase tracking-[.06em] [font-synthesis:none] px-1.5 py-[2px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))] data-[on='1']:bg-destructive data-[on='1']:text-destructive-foreground data-[on='1']:shadow-none"
      >
        Clip
      </span>
    </div>
  );
}
