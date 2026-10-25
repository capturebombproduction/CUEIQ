"use client";

// CONSOLE's SET MIXER as a pad player (พี่ 2026-10-24, the Mac app MiX16 PRO; mockup round 1 OK'd
// 2026-10-25). One tile per row: its kind, a fader for its level, its loudness against −14 LUFS,
// its time, a PAD and its title; a GO bar at the foot.
//
//   yellow pad = ready · green = sounding (the row on now, or a layer still playing under it) ·
//   grey = played (never red: red is ON AIR on this screen).
//
// In MANUAL, on the device that runs the show, a yellow or grey pad plays its row from the top
// at once and makes it NOW, a green one fades out in Auto Mute's 3 s, and GO (or Enter) fires the
// row after NOW. Everywhere else the pads only show (AUTO: locked; a viewer: the master's lights).
// Like the rest of CONSOLE this owns no show state and never touches a player: every press calls
// back into components/event/live-mode.tsx, which does the sound (lib/live-layers.ts).

import { memo, useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { trimFor } from "@/lib/console-view";
import { PAD_FADE_MS, PAD_MAX_SOUNDING } from "@/lib/live-layers";
import {
  GO_LOCKED,
  padProgress,
  padState,
  padSub,
  padTimes,
  soundingCount,
  trimTick,
  type PadMode,
  type PadSound,
  type PadState,
} from "@/lib/pad-view";
import { SETLIST_KIND_SHORT } from "@/lib/types";
import type { ConsoleItem } from "@/components/live/console-board";

/** What Live tells the pads (components/event/live-mode.tsx builds it). */
export interface PadsView {
  mode: PadMode;
  /** itemId → what sounds of it now (the row on now, and every layer under it) */
  sounding: Readonly<Record<string, PadSound>>;
  /** rows that have sounded in this run */
  played: ReadonlySet<string>;
  /** each row's level 0-100 (its tile's fader) */
  levels: Readonly<Record<string, number>>;
  /** Live's clock (ms): a fade's seconds count from it */
  now: number;
  /** null = read only (AUTO, a viewer, before START) */
  onPad: ((index: number) => void) | null;
  onGo: (() => void) | null;
  onLevel: ((itemId: string, level: number) => void) | null;
}

const IDLE: PadsView = {
  mode: "idle",
  sounding: {},
  played: new Set(),
  levels: {},
  now: 0,
  onPad: null,
  onGo: null,
  onLevel: null,
};

const signedDb = (db: number) => (Math.abs(db) < 0.05 ? "0.0" : `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)}`);

/** Is the element on screen: no ancestor display:none (a short stage hides this whole panel). */
function shown(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === "none") return false;
  }
  return true;
}

const PAD_WORDS: Record<PadState, string> = {
  ready: "พร้อม",
  on: "กำลังเล่น · แตะเพื่อเฟดออก",
  fade: "กำลังเฟดออก",
  played: "เล่นแล้ว",
};

export const SetMixer = memo(function SetMixer({
  items,
  index,
  playingId,
  liveRef,
  count = null,
  pads,
}: {
  items: readonly ConsoleItem[];
  /** NOW: the row on now (Live's currentIndex) */
  index: number;
  /** the row on this device's player (the desktop app's live LED rides its tile) */
  playingId: string | null;
  liveRef: RefObject<HTMLSpanElement | null>;
  /** AUTO's 5 4 3 2 1 before the next row comes in (lib/live-entry.ts), over that row's pad */
  count?: number | null;
  pads?: PadsView | null;
}) {
  const p = pads ?? IDLE;
  const live = p.mode === "manual" && !!p.onPad;
  const goIndex = index + 1 < items.length ? index + 1 : -1;
  const go = goIndex >= 0 ? items[goIndex] : null;
  const sounding = soundingCount(p.sounding);

  // Enter = GO, as Space is START / RUN (live-mode.tsx): taken whatever has the focus - a pad
  // clicked a moment ago, the dock's RUN - so the key that fires the next row never pauses the
  // show instead. Not while typing, not with a modifier, and only while GO is on screen (the
  // SET MIXER tab open, the panel not stepped aside on a short stage). A held key is one GO:
  // the browser's default goes on every repeat, the press happens once.
  const goRef = useRef<HTMLButtonElement>(null);
  const onGoRef = useRef<(() => void) | null>(null);
  onGoRef.current = live ? p.onGo : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return;
      const fire = onGoRef.current;
      const btn = goRef.current;
      if (!fire || !btn || btn.disabled || !shown(btn)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      // a question on screen (จบการแสดงเลยไหม after Auto Mute): Enter on its button is that
      // button - GO there would start the next song as the show ends
      if (t?.closest?.('[role="dialog"]')) return;
      e.preventDefault();
      if (e.repeat) return;
      fire();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // NOW stays in view when the setlist is wider than the panel
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    const tile = row?.children[index] as HTMLElement | undefined;
    if (!row || !tile) return;
    const left = tile.offsetLeft;
    const right = left + tile.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 4);
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 4;
  }, [index, items.length]);

  return (
    // a size container: on a short stage the tiles give up their time line first (the pad shows
    // what is left), then their title (the tile's tooltip still has it) - never the pad
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 pb-1.5 pt-1.5 [container-type:size]">
      <div ref={rowRef} className="relative flex min-h-0 flex-1 gap-[3px] overflow-x-auto">
        {items.map((it, i) => {
          const sound = p.sounding[it.id];
          const state = padState(sound, p.played.has(it.id));
          const sub = padSub(state, sound, p.now);
          const isNow = i === index;
          const isGo = live && i === goIndex;
          const trim = it.kind === "song" ? trimFor(it.lufs) : null;
          const level = sound?.level ?? p.levels[it.id] ?? 100;
          const fadeP = state === "fade" && sound?.fadeAt != null ? Math.min(1, Math.max(0, (p.now - sound.fadeAt) / PAD_FADE_MS)) : 0;
          const dim = p.mode === "auto" || p.mode === "idle";
          return (
            <div
              key={it.id}
              data-testid="console-strip"
              data-pad={state}
              title={it.title}
              className={cn(
                "relative flex min-w-[52px] flex-1 flex-col gap-[3px] rounded-[2px] p-[3px]",
                isNow ? "bg-primary/[.14] shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]" : "bg-foreground/[.03]"
              )}
            >
              <div className="flex h-[13px] shrink-0 items-center gap-[3px]">
                <span className="en truncate text-[9.5px] leading-none tracking-[.06em] text-muted-foreground">
                  {it.kind ? SETLIST_KIND_SHORT[it.kind] ?? "" : ""}
                </span>
                {isNow ? (
                  <span data-testid="console-pad-now" className="ml-auto shrink-0 bg-primary px-1 font-display-x text-[10px] font-extrabold italic leading-[13px] tracking-[.06em] text-primary-foreground [font-synthesis:none]">
                    NOW
                  </span>
                ) : isGo ? (
                  <span className="ml-auto shrink-0 px-1 font-display-x text-[10px] font-extrabold italic leading-[13px] tracking-[.06em] text-primary-ink shadow-[inset_0_0_0_1px_hsl(var(--primary))] [font-synthesis:none]">
                    GO
                  </span>
                ) : null}
              </div>
              <div className="flex min-h-[18px] flex-1 gap-1">
                <TileFader
                  value={Math.round(level)}
                  tick={trimTick(trim)}
                  label={`ความดัง ${i + 1} ${it.title || "—"}`}
                  onChange={p.onLevel && live ? (v) => p.onLevel?.(it.id, v) : null}
                />
                <div className="relative flex min-w-0 flex-1 flex-col items-end justify-end gap-px">
                  {it.id === playingId && (
                    <span
                      ref={liveRef}
                      aria-hidden
                      className="led-live absolute bottom-0 left-0 top-0 w-[3px] origin-bottom"
                      style={{ transform: "scaleY(0)" }}
                    />
                  )}
                  <span className="num text-[12.5px] leading-none">{it.lufs != null ? it.lufs.toFixed(1) : "—"}</span>
                  <span className={cn("num text-[10.5px] leading-none", trim != null && trim <= -1 ? "text-warning-ink" : "text-muted-foreground")}>
                    {trim != null && trim < 0 ? signedDb(trim) : " "}
                  </span>
                </div>
              </div>
              <div
                className={cn(
                  "num h-[11px] shrink-0 whitespace-nowrap text-center text-[11px] leading-[11px] [@container_(max-height:159px)]:hidden",
                  sound ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {padTimes(sound, it.audioLen || it.block)}
              </div>
              <button
                type="button"
                data-testid="console-pad"
                data-state={state}
                onClick={live ? () => p.onPad?.(i) : undefined}
                disabled={!live}
                aria-label={`แป้น ${i + 1} ${it.title || "—"} — ${PAD_WORDS[state]}`}
                className={cn(
                  "relative flex h-8 shrink-0 flex-col items-center justify-center overflow-hidden rounded-[2px]",
                  state === "ready" && "bg-warning text-warning-foreground",
                  (state === "on" || state === "fade") && "bg-success/25 text-foreground",
                  state === "played" && "bg-muted text-muted-foreground",
                  live ? "cursor-pointer" : "cursor-default",
                  dim && "opacity-50"
                )}
                style={state === "fade" ? { opacity: 1 - 0.7 * fadeP } : undefined}
              >
                {sound && (
                  <span aria-hidden className="absolute inset-y-0 left-0 bg-success/45" style={{ width: `${padProgress(sound) * 100}%` }} />
                )}
                <span className="num relative text-[17px] font-extrabold leading-none">{i + 1}</span>
                {sub && <span className="relative text-[10px] font-bold leading-[1.15]">{sub}</span>}
              </button>
              <div className="h-[11px] shrink-0 truncate text-center text-[9.5px] leading-[11px] text-muted-foreground [@container_(max-height:133px)]:hidden">{it.title}</div>
              {count != null && i === index + 1 && (
                <span data-testid="console-strip-count" className="pointer-events-none absolute inset-x-0 top-[22px] flex justify-center">
                  <b key={count} className="entry-digit num rounded-[2px] bg-background/85 px-1.5 text-[30px] leading-[36px] text-warning-ink">
                    {count}
                  </b>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex h-[30px] shrink-0 gap-1.5">
        <div
          data-testid="console-pads-sounding"
          className="flex w-[150px] shrink-0 items-center gap-1.5 rounded-[2px] bg-muted px-2.5 text-[12px] text-muted-foreground"
        >
          เล่นอยู่ <b className="num text-[18px] leading-none text-foreground">{sounding}</b> / {PAD_MAX_SOUNDING}
        </div>
        {live ? (
          <button
            ref={goRef}
            type="button"
            data-testid="console-go"
            onClick={() => p.onGo?.()}
            disabled={!go}
            aria-label={go ? `GO ${goIndex + 1} ${go.title || "—"} (Enter)` : "GO — จบรายการแล้ว"}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[2px] bg-primary px-3 text-primary-foreground [clip-path:polygon(0_0,calc(100%_-_10px)_0,100%_10px,100%_100%,0_100%)] hover:bg-primary/90 disabled:opacity-50"
          >
            <span className="font-display-x text-[21px] font-extrabold italic leading-none tracking-[.04em] [font-synthesis:none]">GO</span>
            {go && <span className="num text-[18px] font-extrabold leading-none">{goIndex + 1}</span>}
            <span className="min-w-0 truncate py-[.25em] text-[13.5px] font-medium">{go ? go.title || "—" : "จบรายการแล้ว"}</span>
            <span className="ml-auto shrink-0 rounded-[2px] bg-primary-foreground/20 px-[7px] py-px font-display text-[11.5px] font-extrabold uppercase tracking-[.1em] [font-synthesis:none]">
              Enter
            </span>
          </button>
        ) : (
          <div
            data-testid="console-go-locked"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[2px] bg-muted px-3 text-[13px] text-muted-foreground"
          >
            <span className="font-display-x text-[21px] font-extrabold italic leading-none tracking-[.04em] opacity-70 [font-synthesis:none]">GO</span>
            <span className="min-w-0 truncate py-[.25em]">{GO_LOCKED[p.mode === "manual" ? "viewer" : p.mode]}</span>
          </div>
        )}
      </div>
    </div>
  );
});

/** A tile's fader: the row's level, dragged or ↑ ↓ (Shift = 10); the amber mark is −14 LUFS. */
function TileFader({
  value,
  tick,
  label,
  onChange,
}: {
  value: number;
  /** the −14 LUFS mark as a fraction of the travel from the bottom, or null */
  tick: number | null;
  label: string;
  onChange: ((v: number) => void) | null;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const CAP = 8;
  const fromY = (clientY: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || r.height <= CAP) return value;
    const pos = 1 - (clientY - r.top - CAP / 2) / (r.height - CAP);
    return Math.round(Math.min(1, Math.max(0, pos)) * 100);
  };
  return (
    <div
      ref={railRef}
      role="slider"
      tabIndex={onChange ? 0 : -1}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value}%`}
      aria-disabled={!onChange}
      data-testid="console-tile-fader"
      title={onChange ? `${label} — ลาก หรือกดลูกศรขึ้น/ลง` : label}
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
        // UP / DOWN only: ← → are the show's BACK and NEXT, as on the PLAYBACK fader
        const step = e.shiftKey ? 10 : 1;
        const to = e.key === "ArrowUp" ? value + step : e.key === "ArrowDown" ? value - step : null;
        if (to === null) return;
        e.preventDefault();
        const v = Math.min(100, Math.max(0, to));
        if (v !== value) onChange(v);
      }}
      className={cn(
        "relative w-[18px] shrink-0 touch-none outline-none focus-visible:ring-1 focus-visible:ring-ring",
        onChange ? "cursor-ns-resize" : "cursor-default"
      )}
    >
      <span aria-hidden className="absolute bottom-1 left-[7px] top-1 w-1 rounded-[2px] bg-foreground/20" />
      {tick != null && (
        <span
          aria-hidden
          data-testid="console-tile-trim"
          className="absolute left-px h-[2px] w-4 bg-warning"
          style={{ top: `calc((1 - ${tick}) * (100% - ${CAP}px) + ${CAP / 2 - 1}px)` }}
        />
      )}
      <span
        aria-hidden
        className="absolute left-0 h-2 w-[18px] rounded-[1px] bg-foreground/85 shadow-[0_1px_2px_hsl(var(--shadow)/.6)]"
        style={{ top: `calc((1 - ${value / 100}) * (100% - ${CAP}px))` }}
      />
    </div>
  );
}
