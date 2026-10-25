// What a SET MIXER pad says (components/live/set-mixer.tsx, mockup round 1 that พี่ OK'd
// 2026-10-25): yellow = ready, green = sounding (the row on now, or a layer under it), grey =
// played (never red: red is ON AIR on this screen). The arithmetic is here, import-light and
// unit-tested (lib/pad-view.test.ts); the panel only draws what these return.

import { dbToVolume, mmss } from "@/lib/console-view";
import { PAD_FADE_MS } from "@/lib/live-layers";

export type PadState = "ready" | "on" | "fade" | "played";

/** Who may press the pads on this device right now. */
export type PadMode = "manual" | "auto" | "viewer" | "idle";

/** What sounds of a row right now: the primary, or a layer under it. */
export interface PadSound {
  /** seconds into its file */
  elapsed: number;
  /** its file's length, seconds (0 = unknown) */
  total: number;
  /** when its fade-out began (ms, wall clock), null while it sounds */
  fadeAt: number | null;
  /** a layer's own level 0-100 (it keeps what it had when it went under); null = the row's */
  level: number | null;
}

export function padState(sound: PadSound | undefined, played: boolean): PadState {
  if (sound) return sound.fadeAt != null ? "fade" : "on";
  return played ? "played" : "ready";
}

/** Seconds into a file from seconds since it started: a looping row goes round, others stop at the end. */
export function fileElapsed(sec: number, total: number, loop: boolean): number {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  if (!(total > 0)) return s;
  return loop ? s % total : Math.min(s, total);
}

/** The pad's small line: what is left of it, its fade, or that it has played. */
export function padSub(state: PadState, sound: PadSound | undefined, now: number): string {
  if (state === "played") return "เล่นแล้ว";
  if (!sound || state === "ready") return "";
  if (state === "fade") {
    const left = PAD_FADE_MS - (now - (sound.fadeAt ?? now));
    return `เฟด ${Math.max(1, Math.ceil(left / 1000))} วิ`;
  }
  return sound.total > 0 ? `−${mmss(Math.max(0, sound.total - sound.elapsed))}` : mmss(sound.elapsed);
}

/** How far through its file a sounding pad is, 0-1 (the lighter green across the pad). */
export function padProgress(sound: PadSound | undefined): number {
  if (!sound || !(sound.total > 0)) return 0;
  return Math.min(1, Math.max(0, sound.elapsed / sound.total));
}

/** The tile's time line: "elapsed / length" while it sounds, else its length. */
export function padTimes(sound: PadSound | undefined, length: number): string {
  const len = sound && sound.total > 0 ? sound.total : length;
  return sound ? `${mmss(sound.elapsed)} / ${mmss(len)}` : mmss(len);
}

/**
 * Where the −14 LUFS mark sits on a tile's fader, as a fraction of its travel from the bottom:
 * the level the fader would come DOWN to (lib/console-view.ts trimFor). Display only - พี่
 * 2026-10-04: no automatic loudness, the venue's engineer does it. Null = no mark.
 */
export function trimTick(trimDb: number | null): number | null {
  if (trimDb == null || !(trimDb < 0)) return null;
  return dbToVolume(trimDb) / 100;
}

/** Sounding pads (the row on now included); a fading one is on its way out and is not counted. */
export function soundingCount(sounds: Readonly<Record<string, PadSound>>): number {
  return Object.values(sounds).filter((s) => s.fadeAt == null).length;
}

/** The panel's head line, by who may press. */
export const PAD_HEAD: Record<PadMode, string> = {
  manual: "MANUAL · แตะแป้นเหลือง = เล่นทันที · แตะแป้นเขียว = เฟดออก 3 วิ",
  auto: "AUTO · แป้นล็อก — สลับเป็น MANUAL เพื่อกดเอง",
  viewer: "ดูอย่างเดียว — กดแป้นได้ที่เครื่องที่เริ่มโชว์",
  idle: "เริ่มโชว์ก่อน แล้วกดแป้นได้ใน MANUAL",
};

/** The GO bar's words where GO cannot be pressed. */
export const GO_LOCKED: Record<Exclude<PadMode, "manual">, string> = {
  auto: "ใช้ได้ใน MANUAL — AUTO เล่นต่อเองตามคิว",
  viewer: "ดูอย่างเดียว",
  idle: "เริ่มโชว์ก่อน",
};
