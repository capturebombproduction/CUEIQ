"use client";

// Live Mode's CONSOLE board (phase B, พี่'s round 3): the show as a DAW sees it. Transport
// readouts, the setlist as an ARRANGEMENT of clips with its notes lane, the item on now as a
// clip editor (its waveform, the practice room's sections, a bar grid), a SET MIXER of every
// item's loudness, and the PLAYBACK channel: LED meters, the track's fader, MUTE / MC / LOUD.
//
// It is a second way of LOOKING at the show Live already runs. Everything it shows comes in
// as props from live-mode.tsx and every key it has calls back into Live's own handlers (the
// same fades, the same volume, the same cue as STAGE). It owns no show state and never touches
// the players: the meters read lib/live-signal.ts's SignalTap, a COPY of the output.
//
// What moves at screen rate (meters, peak, clip, BAR.BEAT, the beat light, the playing
// strip's live bar) is written straight onto its nodes by one requestAnimationFrame loop, as
// the Signal strip does; React re-renders only on Live's own 500 ms tick.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Lightbulb, Volume1, Volume2, VolumeX } from "lucide-react";
import { KindChip } from "@/components/event/kind";
import { ConsoleAnalyzer } from "@/components/live/console-analyzer";
import { cn } from "@/lib/utils";
import { formatCountdown, formatDuration, formatOvertime } from "@/lib/time";
import { thresholds, type LiveZone } from "@/lib/live-zone";
import { CLIP_LEVEL, METER_FLOOR_DB, meterPos, toDb, type OutputKind, type SignalTap } from "@/lib/live-signal";
import { decodeWaveform } from "@/lib/song-analysis";
import { beatAt, sectionAt, waveOverBlock, type LiveMarker } from "@/lib/song-signal";
import {
  arrangementWindow,
  barBeat,
  barLines,
  blockStarts,
  inWindow,
  lufsBar,
  LOUDNESS_TARGET,
  mmss,
  resample,
  rulerMarks,
  sectionRegions,
  trimFor,
  volumeToDb,
  waveBars,
} from "@/lib/console-view";
import { SETLIST_KIND_SHORT, type SetlistKind } from "@/lib/types";

export interface ConsoleItem {
  id: string;
  /** null for an offline cached row that lost its kind */
  kind: SetlistKind | null;
  title: string;
  /** the whole block, buffers included (seconds): what the countdown counts */
  block: number;
  /** where the audio starts in the block, and the FILE's own length (the song's; the row's
   *  length where the file's is unknown) - the waveform and the bar grid run on the file */
  audioStart: number;
  audioLen: number;
  /** the row loops its file to fill the block (setlist_items.loop_audio) */
  loop: boolean;
  notes: string | null;
  songId: string | null;
  /** the song's 0045 analysis and tempo (null = unmeasured / no song) */
  lufs: number | null;
  peaks: string | null;
  bpm: number | null;
  beatOffset: number | null;
  /** the item's mic SWAPS (setlist_items.mic_slots; none = the Mic Map as it stands) */
  mics: readonly { mic: string; member: string }[];
}

/** How long a clip keeps the light on, and a peak its hold mark (as the Signal strip). */
const CLIP_HOLD_MS = 1500;
const PEAK_HOLD_MS = 1200;
/** The meters' scale, dBFS (meterPos: −48 at the bottom, 0 at the top). */
const METER_MARKS = [0, -6, -12, -18, -24, -36, -48];

const pad2 = (n: number) => String(n).padStart(2, "0");
const signedDb = (db: number) => (Math.abs(db) < 0.05 ? "0.0" : `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)}`);

export function ConsoleBoard({
  items,
  index,
  elapsed,
  remaining,
  zone,
  running,
  endClock,
  markers,
  playingId,
  sounding = false,
  tap,
  player,
  volume,
  onVolume,
  onFade,
  volumeDead = false,
  output,
  soundOn,
  onOutput,
  onCue,
  nextLoudness,
  alarm = null,
}: {
  items: readonly ConsoleItem[];
  /** the cued item (Live's currentIndex) */
  index: number;
  /** seconds into its block, and what is left of it (the countdown's own clock) */
  elapsed: number;
  remaining: number;
  zone: LiveZone;
  running: boolean;
  /** when the item ends on the wall clock, "HH:MM:SS" */
  endClock: string;
  /** song id → the practice room's sections, in AUDIO seconds */
  markers: Record<string, LiveMarker[]>;
  /** the item loaded on this device's player, playing or paused (null: none) */
  playingId: string | null;
  /** that player is playing right now */
  sounding?: boolean;
  tap: SignalTap | null;
  /** the primary player: position, volume, muted (read only) */
  player: () => HTMLMediaElement | null;
  /** the cued item's volume 0-100, or null where STAGE shows no fades either */
  volume: number | null;
  /** null = read only (a viewer) */
  onVolume: ((v: number) => void) | null;
  onFade: ((target: number, ms?: number) => void) | null;
  /** iPhone / iPad sounding the show: the player's volume cannot be set there (STAGE says so
   *  beside its fades, and so does this, beside the fader) */
  volumeDead?: boolean;
  /** where the sound goes (desktop app), null where the build cannot tell */
  output: { label: string | null; kind: OutputKind } | null;
  /** this device makes the show's sound */
  soundOn: boolean;
  /** opens Live tools, where the output picker lives; focus comes back to `opener` */
  onOutput: (opener: HTMLElement) => void;
  /** cue an item (STAGE's running-order tap); null = locked (Auto, a viewer) */
  onCue: ((i: number) => void) | null;
  /** the next song against this one, dB (lib/song-signal.ts loudnessDelta) */
  nextLoudness: number | null;
  /** NO SIGNAL / STALLED / DEVICE LOST: the same band STAGE lays over its NOW card */
  alarm?: ReactNode;
}) {
  const current = items[index] ?? null;
  const next = items[index + 1] ?? null;
  // Manual: NEXT cues an item while the last one keeps sounding. The meters read what SOUNDS,
  // the fader and the fades act on what is CUED (as STAGE's NOW card does) - say so when they differ.
  const soundingIndex = playingId ? items.findIndex((it) => it.id === playingId) : -1;
  const split = sounding && soundingIndex >= 0 && soundingIndex !== index;

  // ── the screen-rate loop: meters, peak, clip, BAR.BEAT, the beat light ──────────────────
  const meterL = useRef<HTMLSpanElement>(null);
  const meterR = useRef<HTMLSpanElement>(null);
  const holdL = useRef<HTMLSpanElement>(null);
  const holdR = useRef<HTMLSpanElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const clipRef = useRef<HTMLSpanElement>(null);
  const barBeatRef = useRef<HTMLSpanElement>(null);
  const beatLedRef = useRef<HTMLSpanElement>(null);
  const stripLive = useRef<HTMLSpanElement>(null);
  const channelRef = useRef<HTMLElement>(null);
  const live = useRef({ tap, player, current, playingId });
  live.current = { tap, player, current, playingId };
  useEffect(() => {
    let raf = 0;
    const hold = { l: 0, r: 0, lAt: 0, rAt: 0, clipAt: -Infinity };
    let lastText = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const p = live.current;
      const el = p.player();
      if (p.tap) {
        const r = p.tap.read();
        // what leaves the app: the copy is taken before the player's volume
        const gain = el && !el.muted ? el.volume : 0;
        const l = r.rmsL * gain;
        const rr = r.rmsR * gain;
        if (r.peakL * gain > hold.l || now - hold.lAt > PEAK_HOLD_MS) {
          hold.l = r.peakL * gain;
          hold.lAt = now;
        }
        if (r.peakR * gain > hold.r || now - hold.rAt > PEAK_HOLD_MS) {
          hold.r = r.peakR * gain;
          hold.rAt = now;
        }
        if (Math.max(r.peakL, r.peakR) * gain >= CLIP_LEVEL) hold.clipAt = now;
        if (meterL.current) meterL.current.style.transform = `scaleY(${1 - meterPos(l)})`;
        if (meterR.current) meterR.current.style.transform = `scaleY(${1 - meterPos(rr)})`;
        if (holdL.current) holdL.current.style.bottom = `${meterPos(hold.l) * 100}%`;
        if (holdR.current) holdR.current.style.bottom = `${meterPos(hold.r) * 100}%`;
        if (stripLive.current) stripLive.current.style.transform = `scaleY(${meterPos(Math.max(l, rr))})`;
        const db = toDb(Math.max(hold.l, hold.r));
        const txt = !r.ready ? "—" : Number.isFinite(db) && db > -60 ? db.toFixed(1) : "−∞";
        if (peakRef.current && peakRef.current.textContent !== txt) peakRef.current.textContent = txt;
        if (clipRef.current) clipRef.current.dataset.on = now - hold.clipAt < CLIP_HOLD_MS ? "1" : "0";
        // the reading as data too: the desktop smoke's audible scenario switches to CONSOLE
        // and asserts on it while its tone plays
        const ch = channelRef.current;
        if (ch) {
          ch.dataset.ready = r.ready ? "1" : "0";
          ch.dataset.db = r.ready && Number.isFinite(db) ? db.toFixed(1) : "";
        }
      }
      // BAR.BEAT and the beat light run on the PLAYER's clock: only while the cued item is
      // the one sounding here, and only for a song with a measured tempo and first beat
      const it = p.current;
      const t = el && !el.paused && it && it.id === p.playingId ? el.currentTime : null;
      const bb = t != null && it ? barBeat(t, it.bpm, it.beatOffset) : null;
      const text = bb ?? "—";
      if (text !== lastText && barBeatRef.current) {
        lastText = text;
        barBeatRef.current.textContent = text;
      }
      if (beatLedRef.current) {
        const b = t != null && it?.bpm != null && it.beatOffset != null ? beatAt(t, it.bpm, it.beatOffset) : null;
        beatLedRef.current.dataset.on = b && b.phase < 0.2 ? (b.beat === 0 ? "1" : "2") : "0";
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── the transport readouts ──────────────────────────────────────────────────────────────
  const curMarkers = useMemo(
    () => (current?.songId ? (markers[current.songId] ?? []).map((m) => ({ label: m.label, at: (current?.audioStart ?? 0) + m.at })) : []),
    [current?.songId, current?.audioStart, markers]
  );
  const section = curMarkers.length > 0 ? sectionAt(curMarkers, elapsed) : null;
  const remainText = Math.round(remaining) < 0 ? formatOvertime(Math.round(remaining)) : formatCountdown(Math.round(remaining));

  return (
    <div
      data-testid="console"
      className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_248px] gap-2.5 px-5 pb-3 pt-2"
    >
      {/* the left column is a size container: on a short stage the SET MIXER steps aside,
          whole, and the arrangement and the editor keep their room */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2 [container-type:size]">
        <div className="relative shrink-0">
          <div role="group" aria-label="Transport" className="flex min-w-0 gap-1 overflow-hidden">
            <Lcd label="Remain" wide tone={zone === "warn" ? "warn" : zone === "urgent" || zone === "over" ? "alarm" : null}>
              <span
                data-testid="console-remain"
                suppressHydrationWarning
                className={cn(
                  "text-[30px] leading-[.95]",
                  zone === "warn" && "text-warning-ink",
                  (zone === "urgent" || zone === "over") && "text-destructive"
                )}
              >
                {remainText}
              </span>
            </Lcd>
            <Lcd label="Position">
              {formatDuration(elapsed)} <span className="text-muted-foreground">/ {formatDuration(current?.block ?? 0)}</span>
            </Lcd>
            <Lcd label="Bar.Beat" title="ห้อง.จังหวะ ของเพลงที่เล่นอยู่ (จากจังหวะที่วัดไว้)">
              <span ref={barBeatRef} data-testid="console-barbeat" className="text-warning-ink">
                —
              </span>
            </Lcd>
            <Lcd label="BPM" narrowHide>
              <span className="flex items-center gap-1.5">
                <span
                  ref={beatLedRef}
                  data-on="0"
                  aria-hidden
                  className="size-[7px] bg-foreground/15 data-[on='1']:bg-primary data-[on='2']:bg-foreground"
                />
                {current?.bpm != null ? Math.round(current.bpm) : "—"}
              </span>
            </Lcd>
            <Lcd label="Section" grow title="ท่อนของเพลงจาก “ท่อน” ที่ตั้งไว้ในห้องซ้อม">
              <span data-testid="console-section" className="truncate">
                {section ? (
                  <>
                    {section.now ?? "—"}
                    {section.next ? (
                      <>
                        {" "}
                        <span className="text-muted-foreground">→</span>{" "}
                        <span className="text-warning-ink">
                          {section.next} {formatDuration(Math.ceil(section.inSec ?? 0))}
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </Lcd>
            <Lcd label="Item">
              {pad2(index + 1)} <span className="text-muted-foreground">/ {pad2(items.length)}</span>
            </Lcd>
            <Lcd label="End">
              <span suppressHydrationWarning>{endClock.slice(0, 5)}</span>
            </Lcd>
          </div>
        </div>

        <Arrangement items={items} index={index} elapsed={elapsed} onCue={onCue} alarm={alarm} />

        <ClipEditor item={current} elapsed={elapsed} running={running} sections={curMarkers} section={section} />

        <BottomPanel items={items} index={index} playingId={playingId} liveRef={stripLive} tap={tap} />
      </div>

      <aside aria-label="Playback" className="flex min-h-0 flex-col gap-2 [container-type:size]">
        <div
          className={cn(
            "flex h-[46px] shrink-0 items-center gap-2 rounded-[2px] px-2.5 [@container_(max-height:420px)]:hidden",
            !soundOn
              ? "bg-muted shadow-edge"
              : output?.kind === "builtin"
                ? "bg-warning/[.14] shadow-[inset_0_0_0_1px_hsl(var(--warning)/.5)]"
                : "bg-success/[.12] shadow-[inset_0_0_0_1px_hsl(var(--success)/.4)]"
          )}
        >
          <span
            aria-hidden
            className={cn("size-2 shrink-0", !soundOn ? "bg-muted-foreground" : output?.kind === "builtin" ? "bg-warning" : "bg-success")}
          />
          <div className="min-w-0 flex-1">
            <div className="en text-[10.5px] tracking-[.1em] text-muted-foreground">Output</div>
            <div data-testid="console-output" className="truncate text-[13px] font-medium leading-tight">
              {!soundOn ? "ปิดเสียงเครื่องนี้" : output?.label ?? "เสียงออกเครื่องนี้"}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => onOutput(e.currentTarget)}
            title="เลือกอุปกรณ์เสียง (Live tools)"
            className="h-8 shrink-0 rounded-[2px] bg-foreground/[.08] px-2 text-[12.5px] hover:bg-foreground/[.14]"
          >
            เปลี่ยน
          </button>
        </div>

        <section
          ref={channelRef}
          aria-label="Playback channel"
          data-testid="console-channel"
          className="slab flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <PanelHead label="Playback">
            {/* the fader's track: the cued item */}
            <span data-testid="console-fader-item" className="min-w-0 truncate text-[12px] text-muted-foreground">
              {current ? `${pad2(index + 1)} ${current.title || "—"}` : ""}
            </span>
            {volume != null && <span className="num ml-auto shrink-0 text-[12px]">{volume}%</span>}
          </PanelHead>
          {split && (
            <p
              data-testid="console-split"
              className="shrink-0 bg-warning/[.14] px-2.5 py-1 text-[11px] leading-snug text-warning-ink shadow-[inset_0_-1px_0_hsl(var(--warning)/.35)]"
            >
              มิเตอร์ = {pad2(soundingIndex + 1)} {items[soundingIndex].title} (ยังเล่นอยู่) · เฟดเดอร์และปุ่ม = รายการที่เลือกไว้
            </p>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[24px_14px_14px_minmax(0,1fr)] gap-1.5 px-3 pb-2 pt-3 [@container_(max-height:420px)]:pt-1.5">
            {/* the meters: lit by the frame loop from the tap (desktop app); without one they
                stand unlit and the line under them says why */}
            <>
                <div className="relative mb-4">
                  {METER_MARKS.map((db) => (
                    <span
                      key={db}
                      className="num absolute right-0 -translate-y-1/2 text-[10px] font-semibold text-muted-foreground"
                      style={{ top: `${(1 - (db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100}%` }}
                    >
                      {db === 0 ? "0" : `−${-db}`}
                    </span>
                  ))}
                </div>
                {(["L", "R"] as const).map((ch) => (
                  <div key={ch} className="flex min-h-0 flex-col gap-1">
                    {/* the segments are a mask on the lit column; the hold mark sits outside it */}
                    <span className="relative min-h-0 flex-1">
                      <span className="led absolute inset-0 overflow-hidden">
                        <span ref={ch === "L" ? meterL : meterR} className="led-off absolute inset-0 origin-top" />
                      </span>
                      {tap && <span ref={ch === "L" ? holdL : holdR} className="absolute inset-x-0 bottom-0 h-[2px] bg-foreground" />}
                    </span>
                    <span className="num text-center text-[10.5px] text-muted-foreground">{ch}</span>
                  </div>
                ))}
            </>
            {volume != null ? (
              <Fader value={volume} onChange={onVolume} />
            ) : (
              <p className="self-center text-center text-[11.5px] leading-snug text-muted-foreground">ไม่มีไฟล์เสียงในรายการนี้</p>
            )}
          </div>
          {!tap ? (
            <p className="shrink-0 px-3 pb-2 text-[11.5px] leading-snug text-muted-foreground [@container_(max-height:420px)]:hidden">
              มิเตอร์ทำงานในแอปเดสก์ท็อปเท่านั้น
            </p>
          ) : (
            <div className="flex shrink-0 items-baseline justify-between px-3 pb-2">
              <span className="text-[11.5px] text-muted-foreground">พีก</span>
              <span ref={peakRef} data-testid="console-peak" className="num text-[20px] leading-none">
                —
              </span>
              <span
                ref={clipRef}
                data-testid="console-clip-light"
                data-on="0"
                className="font-display-x px-1.5 py-[2px] text-[11px] font-extrabold uppercase tracking-[.06em] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))] [font-synthesis:none] data-[on='1']:bg-destructive data-[on='1']:text-destructive-foreground data-[on='1']:shadow-none"
              >
                Clip
              </span>
            </div>
          )}
          {volumeDead && volume != null && (
            <p data-testid="console-volume-dead" className="shrink-0 px-2.5 pb-1.5 text-[11px] leading-snug text-warning-ink">
              เครื่องนี้ (iPhone/iPad) ปรับระดับเสียงในแอปไม่ได้ — เฟดเดอร์กับปุ่มหรี่จะไม่มีผลจริง ใช้ปุ่มเพิ่ม/ลดเสียงข้างเครื่อง
              (ปุ่มปิดเสียงยังใช้ได้)
            </p>
          )}
          <div className="grid shrink-0 grid-cols-3 gap-1 px-2 pb-2">
            {(
              [
                ["Mute", VolumeX, 0, 3000, "ค่อย ๆ ปิดเสียงเป็น 0% ใน 3 วินาที"],
                ["MC", Volume1, 30, undefined, "ค่อย ๆ ลดเสียงลงเป็น 30% ใน 2 วินาที (ช่วง MC)"],
                ["Loud", Volume2, 100, 2500, "ค่อย ๆ เพิ่มเสียงกลับเป็น 100% ใน 2.5 วินาที"],
              ] as const
            ).map(([label, Icon, target, ms, title]) => (
              <button
                key={label}
                type="button"
                onClick={() => onFade?.(target, ms)}
                disabled={!onFade || volume == null}
                title={title}
                className="en flex h-9 items-center justify-center gap-1 rounded-[2px] bg-foreground/[.07] text-[13px] shadow-[inset_0_0_0_1px_hsl(var(--border))] hover:bg-foreground/[.12] disabled:opacity-40 [&_svg]:size-3.5"
              >
                <Icon aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Next channel" className="slab shrink-0 px-2.5 pb-2.5 pt-2">
          {next ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <span className="nlabel text-[16px]">Next</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{next.title || "—"}</span>
                <span className="num shrink-0 text-[15px]">{formatDuration(next.block)}</span>
              </div>
              {/* against the song on now; a next SONG that is not measured says so, anything
                  else (an MC next, an MC now) has nothing to compare and shows nothing, as STAGE */}
              {nextLoudness != null ? (
                <div
                  data-testid="console-next-loudness"
                  className={cn(
                    "mt-1.5 flex items-center gap-1.5 rounded-[2px] px-2 py-1 text-[11.5px]",
                    nextLoudness > 2
                      ? "bg-warning/[.14] text-warning-ink shadow-[inset_0_0_0_1px_hsl(var(--warning)/.45)]"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  <span className="num text-[15px] text-foreground">
                    {Math.abs(nextLoudness) < 1 ? "≈ 0 dB" : `${nextLoudness > 0 ? "▲" : "▼"} ${signedDb(nextLoudness)} dB`}
                  </span>
                  {Math.abs(nextLoudness) < 1
                    ? "ดังใกล้เคียงเพลงนี้"
                    : nextLoudness > 0
                      ? "ดังกว่า — เตรียมลดเฟดเดอร์"
                      : "เบากว่าเพลงนี้"}
                </div>
              ) : next.songId && next.lufs == null ? (
                <div data-testid="console-next-loudness" className="mt-1.5 rounded-[2px] bg-muted px-2 py-1 text-[11.5px] text-muted-foreground">
                  ยังไม่ได้วัดความดังของเพลงนี้
                </div>
              ) : null}
              {/* the mics to prepare: the item's SWAPS; none = the Mic Map (STAGE's wording) */}
              <div data-testid="console-next-mics" className="mt-1.5">
                {next.mics.length > 0 ? (
                  <div className="grid grid-cols-3 gap-[3px]">
                    {next.mics.map((m, k) => (
                      <span key={`${m.mic}-${k}`} className="flex min-w-0 items-baseline gap-1 rounded-[2px] bg-muted px-1.5 py-0.5">
                        <span className="num text-[14px] leading-none">{m.mic}</span>
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{m.member}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-muted-foreground">
                    — {(current?.mics.length ?? 0) > 0 ? "กลับไมค์ตาม Mic Map" : "ไมค์ตาม Mic Map"} —
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="py-1 text-center text-[13px] text-muted-foreground">— จบโชว์ — ไม่มีรายการถัดไป</p>
          )}
        </section>
      </aside>
    </div>
  );
}

/** One transport readout: a dark well, a small caps label, a big tabular value. */
function Lcd({
  label,
  wide = false,
  grow = false,
  narrowHide = false,
  tone = null,
  title,
  children,
}: {
  label: string;
  wide?: boolean;
  grow?: boolean;
  /** steps aside when the column is narrow (a 900-990 px stage) */
  narrowHide?: boolean;
  /** the item clock's zone, as a wash behind the readout (the NOW card's ladder) */
  tone?: "warn" | "alarm" | null;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      title={title}
      className={cn(
        "lcd flex min-w-0 shrink-0 flex-col px-2.5 pb-0.5 pt-[3px]",
        wide && "min-w-[84px]",
        grow && "min-w-[120px] flex-1 shrink",
        narrowHide && "[@container_(max-width:680px)]:hidden",
        tone === "warn" && "!bg-warning/[.16]",
        tone === "alarm" && "!bg-destructive/[.2]"
      )}
    >
      <span className="en text-[10px] tracking-[.1em] text-muted-foreground">{label}</span>
      <span className="num flex min-w-0 items-baseline gap-1 whitespace-nowrap text-[21px] leading-[1.15]">{children}</span>
    </div>
  );
}

function PanelHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-2.5 bg-foreground/[.04] px-2.5 shadow-[inset_0_-1px_0_hsl(var(--border))]">
      <span className="en text-[12.5px] tracking-[.08em] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A clip's fill by kind: songs in the band colour, MC / guest neutral, the rest quiet. */
function clipTone(kind: SetlistKind | null, state: "past" | "now" | "later"): string {
  if (kind === "song") return state === "now" ? "bg-primary/50" : state === "past" ? "bg-primary/[.12]" : "bg-primary/25";
  if (kind === "mc" || kind === "guest") return state === "past" ? "bg-foreground/[.05]" : "bg-foreground/[.11]";
  return state === "past" ? "bg-muted/60" : "bg-muted";
}

// ── THE ARRANGEMENT ───────────────────────────────────────────────────────────────────────
// The setlist on the show's PLAN timeline (block lengths, as the dock's run meter): a mini
// map of the whole show with the visible window, a ruler, the AUDIO lane of clips (each with
// its song's waveform) and the NOTES lane (the cue each item carries). The window follows the
// playhead. A clip cues its item where STAGE's running order would (onCue's lock is STAGE's).
const Arrangement = memo(function Arrangement({
  items,
  index,
  elapsed,
  onCue,
  alarm,
}: {
  items: readonly ConsoleItem[];
  index: number;
  elapsed: number;
  onCue: ((i: number) => void) | null;
  /** NO SIGNAL / STALLED / DEVICE LOST, laid over this panel's head: the transport above (REMAIN,
   *  the item's clock) stays readable, as STAGE's countdown does under its band */
  alarm?: ReactNode;
}) {
  const { starts, total } = useMemo(() => blockStarts(items.map((it) => it.block)), [items]);
  const curBlock = items[index]?.block ?? 0;
  const playhead = (starts[index] ?? 0) + Math.min(Math.max(0, elapsed), curBlock);
  const win = arrangementWindow(playhead, total);
  // each clip's waveform, drawn once per song (the window moves, the shapes do not)
  const waves = useMemo(
    () =>
      items.map((it) => {
        const lv = decodeWaveform(it.peaks);
        // the file on the row's own clock (lib/song-signal.ts waveOverBlock), across the whole clip
        const over = lv.length > 0 ? waveOverBlock(lv, { block: it.block, start: it.audioStart, fileLen: it.audioLen, loop: it.loop, columns: 200 }) : [];
        return over.length > 0 ? waveBars(resample(over, 56), 0.7, 0.04) : null;
      }),
    [items]
  );
  const marks = rulerMarks(win);
  const nextNote = items.findIndex((it, i) => i > index && !!it.notes);
  const pct = (sec: number) => `${((sec - win.start) / win.span) * 100}%`;
  return (
    <section aria-label="Arrangement" className="slab relative flex min-h-[112px] flex-[1.05] flex-col overflow-hidden">
      {alarm && <div className="absolute inset-x-0 top-0 z-20">{alarm}</div>}
      <PanelHead label="Arrangement">
        <span className="num truncate text-[12px] text-muted-foreground">
          {mmss(win.start)}–{mmss(win.start + win.span)} · {items.length} รายการ
        </span>
      </PanelHead>
      {/* the whole show: blocks by kind, the window, the playhead */}
      <div className="relative mx-2.5 mb-1 ml-[82px] mt-1.5 h-2.5 shrink-0">
        {/* by percent, as the window and the playhead are: flex gaps drifted them apart */}
        {total > 0 &&
          items.map((it, i) => (
            <span
              key={it.id}
              className={cn(
                "absolute inset-y-0 border-r border-card",
                i === index ? "bg-primary" : i < index ? "bg-foreground/15" : it.kind === "song" ? "bg-primary/35" : "bg-foreground/20"
              )}
              style={{ left: `${(starts[i] / total) * 100}%`, width: `${(it.block / total) * 100}%` }}
            />
          ))}
        {total > 0 && (
          <>
            <span
              aria-hidden
              className="absolute -inset-y-0.5 bg-foreground/[.06] shadow-[inset_0_0_0_1px_hsl(var(--foreground)/.7)]"
              style={{ left: `${(win.start / total) * 100}%`, width: `${(win.span / total) * 100}%` }}
            />
            <span aria-hidden className="absolute -inset-y-1 w-[2px] bg-destructive" style={{ left: `${(playhead / total) * 100}%` }} />
          </>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[72px_minmax(0,1fr)]">
        <div className="grid grid-rows-[18px_minmax(0,1fr)_30px] shadow-[inset_-1px_0_0_hsl(var(--border))]">
          <span />
          <div className="flex flex-col justify-center px-2 shadow-[inset_0_-1px_0_hsl(var(--border))]">
            <span className="en text-[12.5px] tracking-[.06em]">Audio</span>
            <span className="text-[10.5px] leading-tight text-muted-foreground">เพลง / SE / MC</span>
          </div>
          <div className="flex flex-col justify-center px-2">
            <span className="en text-[12.5px] tracking-[.06em]">Notes</span>
          </div>
        </div>
        <div className="relative grid min-w-0 grid-rows-[18px_minmax(0,1fr)_30px] overflow-hidden">
          <div className="relative bg-background/40 shadow-[inset_0_-1px_0_hsl(var(--border))]">
            {marks.map((m) => (
              <span
                key={m.at}
                className="num absolute inset-y-0 border-l border-foreground/20 pl-[3px] text-[11px] font-semibold leading-[18px] text-muted-foreground"
                style={{ left: `${m.pct}%` }}
              >
                {m.label}
              </span>
            ))}
          </div>
          <div className="relative shadow-[inset_0_-1px_0_hsl(var(--border))]">
            {items.map((it, i) => {
              if (!inWindow(starts[i], it.block, win)) return null;
              const state = i < index ? "past" : i === index ? "now" : "later";
              const wave = waves[i];
              const cut = Math.max(0, win.start - starts[i]); // seconds of the clip left of the window
              return (
                <button
                  key={it.id}
                  type="button"
                  data-testid="console-clip"
                  onClick={onCue ? () => onCue(i) : undefined}
                  disabled={!onCue}
                  title={onCue ? `${it.title} — แตะเพื่อเลือกรายการนี้` : it.title}
                  className={cn(
                    "absolute inset-y-[5px] flex flex-col overflow-hidden rounded-[2px] text-left disabled:cursor-default",
                    clipTone(it.kind, state),
                    i === index
                      ? "shadow-[inset_0_0_0_1px_hsl(var(--primary)),0_0_12px_hsl(var(--primary)/.35)]"
                      : i === index + 1
                        ? "shadow-[inset_0_0_0_2px_hsl(var(--warning))]"
                        : "shadow-[inset_0_0_0_1px_hsl(var(--foreground)/.12)]"
                  )}
                  style={{ left: pct(starts[i]), width: `calc(${(it.block / win.span) * 100}% - 2px)` }}
                >
                  <span
                    className={cn(
                      "truncate px-1.5 pt-0.5 text-[11px] font-medium",
                      state === "past" ? "text-muted-foreground" : "text-foreground"
                    )}
                    style={cut > 0 ? { paddingLeft: `calc(${(cut / it.block) * 100}% + 6px)` } : undefined}
                  >
                    <span className="num text-[12px]">{pad2(i + 1)}</span> {it.title || "—"}
                  </span>
                  {wave && it.block > 0 && (
                    // a box for the svg to fill: placed by top + bottom alone, an svg takes its
                    // height from its viewBox and spills out of the clip
                    <span aria-hidden className="absolute inset-x-0 bottom-1 top-4">
                      <svg
                        viewBox="0 0 56 100"
                        preserveAspectRatio="none"
                        className={cn("block size-full", state === "now" ? "fill-foreground/80" : "fill-foreground/30")}
                      >
                        <path d={wave} />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="relative">
            {items.map((it, i) => {
              // the item on now keeps its note when its start has scrolled off (a long MC), pinned
              // to the window's left edge as its clip's title is
              const pinned = i === index && starts[i] < win.start;
              if (!it.notes || (!pinned && (starts[i] < win.start || starts[i] >= win.start + win.span))) return null;
              const up = i === nextNote;
              const past = i < index;
              return (
                <span
                  key={it.id}
                  title={it.notes}
                  className={cn(
                    "absolute top-[5px] flex h-5 max-w-[30%] items-center gap-1 overflow-hidden rounded-[2px] px-1.5 text-[11px] [&_svg]:size-3 [&_svg]:shrink-0",
                    up
                      ? "bg-warning/[.16] text-warning-ink shadow-[inset_2px_0_0_hsl(var(--warning))]"
                      : past
                        ? "bg-foreground/[.04] text-faint"
                        : i === index
                          ? "bg-primary/[.14] text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]"
                          : "bg-foreground/[.06] text-muted-foreground shadow-[inset_2px_0_0_hsl(var(--foreground)/.3)]"
                  )}
                  style={{ left: pct(Math.max(starts[i], win.start)) }}
                >
                  <Lightbulb aria-hidden />
                  <span className="truncate">
                    {it.notes}
                    {up && ` · ใน ${formatDuration(Math.ceil(starts[i] - playhead))}`}
                  </span>
                </span>
              );
            })}
          </div>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-[2px] bg-destructive shadow-[0_0_8px_hsl(var(--destructive)/.9)] transition-[left] duration-500 ease-linear"
            style={{ left: pct(playhead) }}
          />
        </div>
      </div>
    </section>
  );
});

// ── THE CLIP EDITOR ───────────────────────────────────────────────────────────────────────
// The cued item across its whole block: the song's waveform where its audio sits (played part
// lit, the last warn stretch amber - the NOW card's ladder), the practice room's sections as
// regions above it, a line every four bars from the analysed first beat and tempo, the time
// under it and the playhead. Nothing here is guessed: no waveform, no grid, no sections when
// the song has none measured or marked - it says so instead.
const ClipEditor = memo(function ClipEditor({
  item,
  elapsed,
  running,
  sections,
  section,
}: {
  item: ConsoleItem | null;
  elapsed: number;
  running: boolean;
  /** the item's sections in BLOCK seconds */
  sections: readonly { label: string; at: number }[];
  section: { now: string | null; next: string | null } | null;
}) {
  const block = item?.block ?? 0;
  // the file on the item's own clock, one column per 200th of the block: its real length, looped
  // or silent after its end (lib/song-signal.ts waveOverBlock)
  const wave = useMemo(() => decodeWaveform(item?.peaks), [item?.peaks]);
  const levels = useMemo(
    () =>
      item
        ? waveOverBlock(wave, { block: item.block, start: item.audioStart, fileLen: item.audioLen, loop: item.loop, columns: 200 })
        : [],
    [item, wave]
  );
  const regions = useMemo(() => sectionRegions(sections, block), [sections, block]);
  const grid = useMemo(
    // the grid over the file's first pass, inside the block
    () => (item ? barLines(item.bpm, item.beatOffset, item.audioStart, Math.min(item.audioLen, item.block - item.audioStart)) : []),
    [item]
  );
  if (!item) return null;
  const at = (sec: number) => `${block > 0 ? (sec / block) * 100 : 0}%`;
  const progress = block > 0 ? Math.min(100, Math.max(0, (elapsed / block) * 100)) : 0;
  const warnFrom = block - thresholds(block).warn;
  // column of the playhead, and of the warn stretch (the columns span the block)
  const n = levels.length;
  const col = (sec: number) => (block > 0 ? Math.round((sec / block) * n) : 0);
  const playedTo = Math.max(0, Math.min(n, col(elapsed)));
  const warnAt = Math.max(playedTo, Math.min(n, col(warnFrom)));
  const ticks = block > 0 ? rulerMarks({ start: 0, span: block }) : [];
  const nextRegion = regions.findIndex((r) => r.start > elapsed);
  return (
    <section aria-label="Clip editor" className="slab flex min-h-[104px] flex-1 flex-col overflow-hidden">
      <PanelHead label="Clip">
        {item.kind && <KindChip kind={item.kind} className="!h-[18px] shrink-0 !px-1.5 !text-[11px]" />}
        <span className="disp min-w-0 truncate text-[13.5px]">{item.title || "—"}</span>
        <span className="num shrink-0 text-[12px] text-muted-foreground">
          {formatDuration(block)}
          {item.lufs != null ? ` · ${item.lufs.toFixed(1)} LUFS` : ""}
          {item.bpm != null ? ` · ${Math.round(item.bpm)} BPM` : ""}
        </span>
        <span className="ml-auto hidden shrink-0 truncate text-[11.5px] text-muted-foreground xl:inline">
          {grid.length > 0 ? "เส้นแบ่ง = ทุก 4 ห้อง · " : ""}แถบเหลือง = ช่วงเตือนท้ายรายการ
        </span>
      </PanelHead>
      <div className="relative mx-2.5 min-h-0 flex-1">
        {/* sections */}
        <div className="absolute inset-x-0 top-1 h-4">
          {regions.map((r, k) => {
            const isNow = section?.now === r.label && elapsed >= r.start && elapsed < r.end;
            const isNext = k === nextRegion;
            return (
              <span
                key={`${r.label}-${r.start}`}
                className={cn(
                  "num absolute inset-y-0 overflow-hidden whitespace-nowrap pl-1 text-[10.5px] leading-4 tracking-[.05em] shadow-[inset_1px_0_0_hsl(var(--foreground)/.2)]",
                  isNow ? "bg-primary text-primary-foreground" : isNext ? "bg-foreground/[.08] text-warning-ink" : "bg-foreground/[.06] text-muted-foreground"
                )}
                style={{ left: at(r.start), width: at(r.end - r.start) }}
              >
                {r.label}
              </span>
            );
          })}
        </div>
        {/* bar grid */}
        <div aria-hidden className="absolute inset-x-0 bottom-4 top-6">
          {grid.map((g) => (
            <span
              key={g.bar}
              className={cn("absolute inset-y-0 border-l", g.bar % 8 === 1 ? "border-foreground/[.14]" : "border-foreground/[.06]")}
              style={{ left: at(g.at) }}
            >
              {g.bar % 8 === 1 && (
                <span className="num absolute left-[3px] top-0 text-[9.5px] text-faint">{g.bar}</span>
              )}
            </span>
          ))}
        </div>
        {/* the waveform, where the audio sits in the block */}
        {n > 0 ? (
          <div
            data-testid="console-wave"
            aria-hidden
            className="absolute inset-x-0 bottom-4 top-6"
          >
            <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="block size-full">
              <path className="fill-foreground" d={waveBars(levels, 0.72, 0.03, 0, playedTo)} />
              <path className="fill-foreground/25" d={waveBars(levels, 0.72, 0.03, playedTo, warnAt)} />
              <path className="fill-warning/60" d={waveBars(levels, 0.72, 0.03, warnAt)} />
            </svg>
          </div>
        ) : (
          <p className="absolute inset-x-0 bottom-4 top-6 grid place-items-center text-[12px] text-muted-foreground">
            {/* nothing to draw: no song, an unmeasured song, or a row with no length to draw it over */}
            {!item.songId
              ? "รายการนี้ไม่ได้ผูกกับเพลงในคลัง"
              : wave.length === 0
                ? "ยังไม่ได้วัดรูปคลื่นของเพลงนี้"
                : "รายการนี้ยาว 0:00 — ตั้งความยาวในเซ็ตลิสต์ก่อน"}
          </p>
        )}
        {/* time */}
        <div className="absolute inset-x-0 bottom-0 h-4">
          {ticks.map((m) => (
            <span
              key={m.at}
              className="num absolute inset-y-0 border-l border-foreground/20 pl-[3px] text-[10.5px] font-semibold leading-4 text-muted-foreground"
              style={{ left: `${m.pct}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <span
          // keyed to the item: a new item's playhead starts at its 0, never slides back to it
          key={item.id}
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-4 top-0.5 w-[2px] bg-foreground shadow-[0_0_8px_hsl(var(--foreground)/.8)]",
            running && "transition-[left] duration-500 ease-linear"
          )}
          style={{ left: `${progress}%` }}
        />
      </div>
    </section>
  );
});

// ── THE SET MIXER ─────────────────────────────────────────────────────────────────────────
// One strip per item: its integrated loudness (0045) against the −14 LUFS line, how far its
// fader would come down to meet it (only ever down: a player's volume tops out at 100 %), and,
// on the strip that is sounding, the live level. Read-only in this phase.
const SetMixer = memo(function SetMixer({
  items,
  index,
  playingId,
  liveRef,
}: {
  items: readonly ConsoleItem[];
  index: number;
  playingId: string | null;
  liveRef: React.RefObject<HTMLSpanElement | null>;
}) {
  const target = lufsBar(LOUDNESS_TARGET) * 100;
  return (
      <div className="flex min-h-0 flex-1 gap-[3px] overflow-x-auto p-2">
        {items.map((it, i) => {
          const trim = it.kind === "song" ? trimFor(it.lufs) : null;
          const playing = it.id === playingId;
          return (
            <div
              key={it.id}
              data-testid="console-strip"
              title={it.title}
              className={cn(
                "flex min-w-[34px] flex-1 flex-col gap-[3px] rounded-[2px] px-[3px] py-1",
                i === index ? "bg-primary/[.12] shadow-[inset_0_0_0_1px_hsl(var(--primary))]" : "bg-foreground/[.03]",
                i < index && "opacity-55"
              )}
            >
              <div className="flex items-baseline justify-between gap-0.5">
                <span className="num text-[12.5px] leading-none">{i + 1}</span>
                <span className="num truncate text-[9px] leading-none text-muted-foreground">
                  {it.kind ? SETLIST_KIND_SHORT[it.kind] ?? "" : ""}
                </span>
              </div>
              <div className="relative min-h-0 flex-1 bg-background/60 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                <span
                  className={cn("absolute bottom-0 left-[3px] right-[9px]", it.kind === "song" ? "bg-primary/70" : "bg-foreground/30")}
                  style={{ height: `${lufsBar(it.lufs) * 100}%` }}
                />
                {playing && (
                  <span
                    ref={liveRef}
                    aria-hidden
                    className="led-live absolute bottom-0 right-[2px] top-0 w-[5px] origin-bottom"
                    style={{ transform: "scaleY(0)" }}
                  />
                )}
                <span aria-hidden className="absolute inset-x-0 border-t border-dashed border-warning/75" style={{ bottom: `${target}%` }} />
              </div>
              <span className="num text-center text-[12.5px] leading-none">{it.lufs != null ? it.lufs.toFixed(1) : "—"}</span>
              <span
                className={cn(
                  "num text-center text-[10.5px] leading-none",
                  trim != null && trim <= -1 ? "text-warning-ink" : "text-muted-foreground"
                )}
              >
                {trim != null && trim < 0 ? signedDb(trim) : "\u00a0"}
              </span>
              <span className="truncate text-center text-[9.5px] leading-tight text-muted-foreground">{it.title}</span>
            </div>
          );
        })}
      </div>
  );
});

// ── THE BOTTOM PANEL ──────────────────────────────────────────────────────────────────────
// ANALYZER | SET MIXER | SPECTROGRAM. The two that read the live sound need the tap (the desktop
// app); the web build has the SET MIXER alone. The choice is kept per device. On a short stage
// the whole panel steps aside (the column's container query) and the analysis stops drawing.
type PanelTab = "analyzer" | "mixer" | "spectrogram";
const TAB_KEY = "cueiq:consoleTab";
const TAB_LABEL: Record<PanelTab, string> = { analyzer: "Analyzer", mixer: "Set mixer", spectrogram: "Spectrogram" };

function BottomPanel({
  items,
  index,
  playingId,
  liveRef,
  tap,
}: {
  items: readonly ConsoleItem[];
  index: number;
  playingId: string | null;
  liveRef: React.RefObject<HTMLSpanElement | null>;
  tap: SignalTap | null;
}) {
  const tabs: PanelTab[] = tap ? ["analyzer", "mixer", "spectrogram"] : ["mixer"];
  const [picked, setPicked] = useState<PanelTab>(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return v === "mixer" || v === "spectrogram" || v === "analyzer" ? v : "analyzer";
    } catch {
      return "analyzer";
    }
  });
  const tab: PanelTab = tabs.includes(picked) ? picked : tabs[0];
  const pick = (t: PanelTab) => {
    setPicked(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* this page still shows it */
    }
  };
  const songs = items.filter((it) => it.songId);
  const measured = songs.filter((it) => it.lufs != null).length;
  return (
    <section
      aria-label={TAB_LABEL[tab]}
      data-testid="console-panel"
      className="slab flex min-h-0 flex-[1.15] flex-col overflow-hidden [@container_(max-height:430px)]:hidden"
    >
      <div className="flex h-7 shrink-0 items-stretch gap-0.5 bg-foreground/[.04] pl-1 pr-2.5 shadow-[inset_0_-1px_0_hsl(var(--border))]">
        <div role="tablist" aria-label="แผงล่าง" className="flex items-stretch gap-0.5">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => pick(t)}
              className={cn(
                "en px-3 text-[12.5px] tracking-[.08em]",
                tab === t
                  ? "bg-card text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="ml-auto min-w-0 self-center truncate pl-2 text-[11.5px] text-muted-foreground">
          {tab === "mixer" ? (
            <>
              ความดังเฉลี่ยของแต่ละรายการ เทียบเป้า <b className="num text-[13px] text-warning-ink">−14 LUFS</b>
              {measured < songs.length ? ` · วัดแล้ว ${measured}/${songs.length} เพลง` : ""}
            </>
          ) : tab === "analyzer" ? (
            "เสียงที่เครื่องนี้ส่งออก หลังเฟดเดอร์ · LUFS ตามมาตรฐาน BS.1770"
          ) : (
            "20 Hz – 20 kHz · เสียงที่เครื่องนี้ส่งออก"
          )}
        </span>
      </div>
      {tab === "mixer" || !tap ? (
        <SetMixer items={items} index={index} playingId={playingId} liveRef={liveRef} />
      ) : (
        <ConsoleAnalyzer tap={tap} trackKey={playingId} view={tab} />
      )}
    </section>
  );
}

// ── THE FADER ─────────────────────────────────────────────────────────────────────────────
// The cued track's volume (the same value as STAGE's ความดัง slider and Live tools), as a
// channel fader: drag the cap, or focus it and use ↑ ↓ (Shift = 10). Read only for a
// viewer. Its scale is the player's own: percent of full, with the dB that makes.
function Fader({ value, onChange }: { value: number; onChange: ((v: number) => void) | null }) {
  const railRef = useRef<HTMLDivElement>(null);
  const CAP = 26;
  const fromY = (clientY: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || r.height <= CAP) return value;
    const pos = 1 - (clientY - r.top - CAP / 2) / (r.height - CAP);
    return Math.round(Math.min(1, Math.max(0, pos)) * 100);
  };
  const db = volumeToDb(value);
  const dbText = Number.isFinite(db) ? `${signedDb(db)} dB` : "−∞ dB";
  return (
    <div className="flex min-h-0 flex-col items-center gap-1">
      <div
        ref={railRef}
        role="slider"
        tabIndex={onChange ? 0 : -1}
        aria-label="ความดังของแทร็คนี้"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}% (${dbText})`}
        aria-disabled={!onChange}
        data-testid="console-fader"
        title={onChange ? "ความดังของแทร็คนี้ — ลาก หรือกดลูกศรขึ้น/ลง (Shift = ทีละ 10)" : "ดูอย่างเดียว — คุมความดังที่เครื่องคุม"}
        onPointerDown={(e) => {
          if (!onChange) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const v = fromY(e.clientY);
          if (v !== value) onChange(v);
        }}
        onPointerMove={(e) => {
          if (!onChange || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
          const v = fromY(e.clientY);
          if (v !== value) onChange(v);
        }}
        onKeyDown={(e) => {
          if (!onChange) return;
          // UP / DOWN only. ← and → are the show's BACK and NEXT (live-mode.tsx, on the window) and
          // a fader keeps the focus after a drag: an operator pressing → for the next song must get
          // the next song, never +1 %. No Home / End either: one key to full level mid-show.
          const step = e.shiftKey ? 10 : 1;
          const to =
            e.key === "ArrowUp"
              ? value + step
              : e.key === "ArrowDown"
                ? value - step
                : e.key === "PageUp"
                  ? value + 10
                  : e.key === "PageDown"
                    ? value - 10
                    : null;
          if (to === null) return;
          e.preventDefault();
          const v = Math.min(100, Math.max(0, to));
          if (v !== value) onChange(v);
        }}
        className={cn(
          "relative min-h-[60px] w-12 flex-1 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring [@container_(max-height:420px)]:min-h-[36px]",
          onChange ? "cursor-ns-resize" : "cursor-not-allowed opacity-60"
        )}
      >
        <span aria-hidden className="absolute bottom-[13px] left-1/2 top-[13px] w-1 -translate-x-1/2 bg-background shadow-[inset_0_0_0_1px_hsl(var(--border))]" />
        <span
          aria-hidden
          className="fader-cap absolute left-1/2 grid h-[26px] w-[46px] -translate-x-1/2 place-items-center"
          style={{ top: `calc((1 - ${value / 100}) * (100% - ${CAP}px))` }}
        >
          <span className="h-[2px] w-[34px] bg-foreground" />
        </span>
      </div>
      <span className="num text-[12.5px] leading-none">{value}%</span>
      <span className="num text-[10.5px] leading-none text-muted-foreground">{dbText}</span>
    </div>
  );
}
