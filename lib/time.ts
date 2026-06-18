// Time helpers for run-time calculation, run sheets, and the live countdown.

export function pad2(n: number): string {
  return Math.abs(Math.floor(n)).toString().padStart(2, "0");
}

/**
 * Format a duration (seconds) as "m:ss" or "h:mm:ss" when >= 1 hour.
 * e.g. 225 -> "3:45", 3930 -> "1:05:30".
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}

/**
 * Parse a duration string into seconds.
 * Accepts "ss", "m:ss", or "h:mm:ss". Returns null if invalid.
 */
export function parseDurationToSeconds(input: string): number | null {
  const str = input.trim();
  if (str === "") return null;
  const parts = str.split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0)) return null;
  if (nums.length === 1) return Math.round(nums[0]);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

/**
 * Parse a clock string "HH:MM" or "HH:MM:SS" into seconds-of-day.
 * Returns null if invalid.
 */
export function parseClockToSeconds(input: string | null | undefined): number | null {
  if (!input) return null;
  const parts = input.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0)) return null;
  const [h, m, s = 0] = nums;
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/** Format seconds-of-day as "HH:MM" (or "HH:MM:SS"). Wraps past midnight. */
export function formatClockOfDay(secondsOfDay: number, withSeconds = false): string {
  const wrapped = ((Math.round(secondsOfDay) % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  const s = wrapped % 60;
  return withSeconds ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`;
}

/** Convert "HH:MM:SS" -> "HH:MM" for display; passthrough on bad input. */
export function shortClock(input: string | null | undefined): string {
  if (!input) return "";
  const sec = parseClockToSeconds(input);
  if (sec == null) return input;
  return formatClockOfDay(sec, false);
}

/**
 * Format a countdown value (seconds, may be negative) as "m:ss" / "h:mm:ss",
 * prefixed with "-" once it goes past zero (over time).
 */
export function formatCountdown(seconds: number): string {
  const neg = seconds < 0;
  const body = formatDuration(Math.abs(seconds));
  return neg ? `-${body}` : body;
}

/** Current wall-clock time as "HH:MM:SS". */
export function nowClock(date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds()
  )}`;
}

// ---------------------------------------------------------------------------
// Setlist run-time engine
// ---------------------------------------------------------------------------
export interface TimingInput {
  duration_seconds: number;
  buffer_before_seconds: number;
  buffer_after_seconds: number;
}

export interface RowTiming {
  slotStartSec: number; // offset-of-day at block start (incl. pre-buffer)
  startSec: number; // content start (after pre-buffer)
  endSec: number; // content end
  slotEndSec: number; // block end (after post-buffer)
  blockSeconds: number; // total block length
  accumulatedSec: number; // elapsed from show start to this block's end
  overHardOut: boolean;
}

export interface SetlistTiming {
  rows: RowTiming[];
  totalSeconds: number; // sum of all block lengths
  endSec: number; // clock-of-day at end of show
  overBy: number; // seconds past hard-out (0 if within)
  isOver: boolean;
}

/**
 * Compute Start / End / Accumulated / Hard-out status for a setlist.
 * `showStartSec` is seconds-of-day (default 0 = treat as pure durations).
 */
export function computeSetlistTimes(
  items: TimingInput[],
  showStartSec = 0,
  hardOutSec: number | null = null
): SetlistTiming {
  let cursor = showStartSec;
  const rows: RowTiming[] = items.map((it, i) => {
    // Negative buffer_before = this song overlaps the PREVIOUS one (continuous
    // play / no gap) → it pulls the timeline back and shortens the total.
    // The first item has nothing to overlap, so clamp it to ≥0.
    const rawBb = it.buffer_before_seconds || 0;
    const bb = i === 0 ? Math.max(0, rawBb) : rawBb;
    const ba = Math.max(0, it.buffer_after_seconds || 0);
    const dur = Math.max(0, it.duration_seconds || 0);
    const slotStartSec = cursor;
    const startSec = slotStartSec + bb;
    const endSec = startSec + dur;
    const slotEndSec = endSec + ba;
    cursor = slotEndSec;
    return {
      slotStartSec,
      startSec,
      endSec,
      slotEndSec,
      blockSeconds: bb + dur + ba,
      accumulatedSec: cursor - showStartSec,
      overHardOut: hardOutSec != null ? slotEndSec > hardOutSec : false,
    };
  });

  const totalSeconds = cursor - showStartSec;
  return {
    rows,
    totalSeconds,
    endSec: cursor,
    overBy: hardOutSec != null ? Math.max(0, cursor - hardOutSec) : 0,
    isOver: hardOutSec != null && cursor > hardOutSec,
  };
}
