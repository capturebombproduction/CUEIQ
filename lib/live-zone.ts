// The Live Mode warning ladder — which colour the big countdown card wears and what
// the line under the numbers says. Shared by the web Live Mode
// (components/event/live-mode.tsx) and the desktop Quick Show
// (desktop/src/pages/my-show.tsx) so the two ports cannot drift apart.
//
// Founder decision (2026-10-01): the old ladder (amber at <= 5 min, red at <= 2 min)
// painted most songs amber for their whole length and a 1:32 SE red from its first
// second, so the colour stopped meaning anything. Two pre-overtime levels stay, but
// they start at ONE minute — WARN at <= 60 s, URGENT at <= 30 s — and a short item
// scales them down to half / a quarter of its block, so nothing warns from the
// moment it starts.

export type LiveZone = "ok" | "warn" | "urgent" | "over";

export interface ZoneThresholds {
  /** remaining <= this (and > urgent) → "warn" */
  warn: number;
  /** remaining <= this (and > 0) → "urgent" */
  urgent: number;
}

const WARN_CAP_SEC = 60;
const URGENT_CAP_SEC = 30;

/**
 * Thresholds for an item whose whole block (buffers included — the same number
 * the countdown counts down from) is `blockSec` long:
 *   warn = min(60, block / 2), urgent = min(30, block / 4).
 * Floored to whole seconds because the caption names the number and the countdown
 * shows whole seconds — "เหลือไม่ถึง 7.5 วินาที" for a 0:15 item reads like a bug.
 * Flooring only ever moves a threshold later, so the "never from the first second"
 * promise holds.
 */
export function thresholds(blockSec: number): ZoneThresholds {
  const block = Number.isFinite(blockSec) ? Math.max(0, blockSec) : 0;
  return {
    warn: Math.floor(Math.min(WARN_CAP_SEC, block / 2)),
    urgent: Math.floor(Math.min(URGENT_CAP_SEC, block / 4)),
  };
}

/**
 * The zone for the current item. A stopped/paused/cued show is always "ok" — the
 * card only changes colour while the clock is actually running, exactly as before.
 */
export function liveZone({
  running,
  remaining,
  blockSec,
}: {
  running: boolean;
  remaining: number;
  blockSec: number;
}): LiveZone {
  if (!running) return "ok";
  if (remaining <= 0) return "over";
  const t = thresholds(blockSec);
  if (remaining <= t.urgent) return "urgent";
  if (remaining <= t.warn) return "warn";
  return "ok";
}

function spokenSeconds(sec: number): string {
  return sec === 60 ? "1 นาที" : `${sec} วินาที`;
}

/** The Thai line under the countdown for `zone`, naming this item's own threshold. */
export function zoneCaption(zone: LiveZone, blockSec: number): string {
  switch (zone) {
    case "over":
      return "เลยเวลาแล้ว";
    case "urgent":
      return `เหลือไม่ถึง ${spokenSeconds(thresholds(blockSec).urgent)}`;
    case "warn":
      return `เหลือไม่ถึง ${spokenSeconds(thresholds(blockSec).warn)}`;
    default:
      return "เวลาคงเหลือของรายการ";
  }
}
