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
 * Accepts "ss", "m:ss", or "h:mm:ss" - and "m.ss" / "h.mm.ss", the way a length is
 * commonly written in Thai ("3.30" = three and a half minutes). Number("3.30") is
 * 3.3, which this used to round to 3 SECONDS: the library saved the song as 0:03 and
 * Auto cut it there. A dotted value whose seconds aren't two digits ("3.5": 3:05 or
 * 3½ minutes?) is refused rather than guessed. Returns null if invalid.
 */
export function parseDurationToSeconds(input: string): number | null {
  let str = input.trim();
  if (str === "") return null;
  if (str.includes(".")) {
    if (str.includes(":") || !/^\d+(\.\d{2}){1,2}$/.test(str)) return null;
    str = str.replace(/\./g, ":");
  }
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
 * The whole seconds Live's countdown shows for `remaining`: rounded UP, so it reads 0:01 until
 * the moment itself and 0:00 only then, and past zero it counts whole seconds over. AUTO's
 * 5 4 3 2 1 (lib/live-entry.ts) reads the same number, so each digit lands on its whole second
 * and the next row comes in on the beat after "1". Rounded to the nearest, every digit came half
 * a second early and a press along with it landed early (2026-10-25 hunt). The 1e-9 keeps a
 * float a hair over a whole second (5.000000001) on that second.
 */
export function clockSeconds(remaining: number): number {
  const s = Math.ceil(remaining - 1e-9);
  return s === 0 ? 0 : s; // never -0
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

/**
 * Overtime as the Live countdown shows it: "+0:24" — always signed "+", whatever the
 * sign of `seconds`, because it is only ever called past zero. A "−" read as "time
 * left" from across a stage; "+" reads as "this much over". formatCountdown keeps its
 * "-1:05" (pinned by tests and used by the older surfaces).
 */
export function formatOvertime(seconds: number): string {
  return `+${formatDuration(Math.abs(seconds))}`;
}

/** Seconds past zero after which the overtime plate stops shouting (alarm → outlined). */
export const SETTLE_AFTER_SEC = 10;

/**
 * True once an item has run SETTLE_AFTER_SEC or more past its end. The overtime plate's
 * full-luminance flip is the alarm; ten seconds of it is enough to have been seen, and
 * a show that deliberately runs long (an encore, an MC that overruns on purpose) should
 * not glare for minutes — so the plate settles into a framed card, hazard band kept.
 */
export function isSettled(remaining: number): boolean {
  return remaining <= -SETTLE_AFTER_SEC;
}

/** Current wall-clock time as "HH:MM:SS". */
export function nowClock(date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds()
  )}`;
}

export type DeadlineTone = "overdue" | "urgent" | "soon" | "ok";

/** Human status for a setlist deadline. null = no deadline set. */
export function deadlineInfo(
  deadline: string | null | undefined,
  now = new Date()
): { label: string; tone: DeadlineTone } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (isNaN(d.getTime())) return null;
  const diffH = (d.getTime() - now.getTime()) / 3_600_000;
  // Pin the formatted date to Bangkok so it's identical on the server (Vercel = UTC)
  // and the client (+7) — otherwise a deadline whose UTC instant lands on a different
  // calendar day than its Bangkok one renders two different strings and trips a
  // hydration mismatch (and shows the wrong day). diffH/tone above are absolute-time
  // differences, so they're already timezone-independent.
  const dateStr = d.toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Bangkok",
  });
  if (diffH < 0) return { label: "เลยกำหนดแล้ว", tone: "overdue" };
  // Under an hour, round(diffH) shows a confusing "เหลือ 0 ชม." — say "ไม่ถึง 1 ชม." instead.
  if (diffH < 1) return { label: "ด่วน! เหลือไม่ถึง 1 ชม.", tone: "urgent" };
  if (diffH < 24) return { label: `ด่วน! เหลือ ${Math.round(diffH)} ชม.`, tone: "urgent" };
  if (diffH < 72)
    return { label: `เหลือ ${Math.ceil(diffH / 24)} วัน`, tone: "soon" };
  return { label: `ครบกำหนด ${dateStr}`, tone: "ok" };
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
  hardOutSec: number | null; // folded past midnight when it's before showStartSec; null if unset
  overBy: number; // seconds past hard-out (0 if within)
  isOver: boolean;
}

/**
 * How long a row RUNS: its own `block`, less `nextLead` - how many seconds the next row is
 * set to come in before it ends ("เล่นซ้อน"). พี่ 2026-10-17: a 4:00 song with the next one
 * at -5 counts 3:55, and the next counts its own length in full from the moment it comes in
 * ("A จบตอน B เข้า"); the outgoing song's last seconds still sound under it - only the
 * counting moves. Live Mode, Quick Show and the run sheet (computeSetlistTimes) all count
 * this way. A lead can at most end the row at its own start.
 */
export function runSecondsOf(block: number, nextLead: number): number {
  const own = Math.max(0, block || 0);
  return own - Math.min(own, Math.max(0, nextLead || 0));
}

/**
 * The one name for a row's buffer_before, on every screen that sets it (the setlist
 * builder, the practice room's set) - พี่ 2026-10-19: "ควรใช้คำเดียวกัน". The field sits
 * on the row that comes in, and says how it comes in after the row above.
 */
export const TIMING_LABEL = "เข้าหลังเพลงก่อนหน้า";

/**
 * What a row's buffer_before does, in words, under the field that sets it: -5 = comes in
 * over the end of the row above, 3 = waits after it, 0 = straight after it.
 */
export function timingMeaning(seconds: number): string {
  const s = Math.round(Number(seconds) || 0);
  if (s < 0) return `เล่นซ้อนเพลงก่อนหน้า ${-s} วิ`;
  if (s > 0) return `รอ ${s} วิ หลังเพลงก่อนหน้าจบ แล้วค่อยเริ่มเพลงนี้`;
  return "เริ่มทันทีที่เพลงก่อนหน้าจบ";
}

/**
 * The old "เผื่อเวลาหลัง" (a row's buffer_after) as the one "ตั้งเวลา" the builder shows
 * now (พี่ 2026-10-19): each row's wait moves onto the row after it - added to that row's
 * buffer_before, so an overlap there nets out the same (wait 3 then -5 = -2) - and a last
 * row's, with no row after it, is dropped. The run times come out the same either way;
 * what changes is that no number is left in a field the screen no longer has. For rows
 * saved before the change: a setlist version being restored (0049 did the live rows).
 */
export function foldWaitsIntoNext<
  T extends { sort_order: number; buffer_before_seconds: number; buffer_after_seconds: number },
>(rows: T[]): T[] {
  const ordered = rows.slice().sort((a, b) => a.sort_order - b.sort_order);
  return ordered.map((row, i) => {
    const carried = i > 0 ? Math.max(0, ordered[i - 1].buffer_after_seconds || 0) : 0;
    const before = (row.buffer_before_seconds || 0) + carried;
    return {
      ...row,
      buffer_before_seconds: Math.max(-300, Math.min(300, before)),
      buffer_after_seconds: 0,
    };
  });
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
  // A hard-out earlier in the clock than the show start (23:00 show, 00:30 hard
  // out) is past midnight, not already blown — fold it forward a day, same idiom
  // as event-live-caller's drift math. Without this every row compares against
  // a hardOutSec that's smaller than the show's own start, so overHardOut is true
  // from the first row and the whole table renders as already over.
  const foldedHardOutSec =
    hardOutSec != null && hardOutSec < showStartSec ? hardOutSec + 86400 : hardOutSec;
  let cursor = showStartSec;
  let prevStartSec = showStartSec;
  const rows: RowTiming[] = items.map((it, i) => {
    // buffer_before = the row's "ตั้งเวลา" against the PREVIOUS row (พี่ 2026-10-19):
    // negative = it comes in that long before the previous one ends (continuous play),
    // pulling the timeline back; positive = it waits that long after it ends. The first
    // row has no previous one - the builder offers no field there, and a number left
    // on a row moved to the top counts for nothing.
    const bb = i === 0 ? 0 : it.buffer_before_seconds || 0;
    const ba = Math.max(0, it.buffer_after_seconds || 0);
    const dur = Math.max(0, it.duration_seconds || 0);
    const slotStartSec = cursor;
    // A big overlap must not pull the clock before the show start, nor before the
    // PREVIOUS item began (an overlap can at most cover the whole previous item) —
    // otherwise an absurd negative buffer would make the run-sheet times run
    // backwards. For normal (small) overlaps slotStartSec+bb already clears both
    // bounds, so this is a no-op.
    const startSec = Math.max(showStartSec, prevStartSec, slotStartSec + bb);
    prevStartSec = startSec;
    const endSec = startSec + dur;
    const slotEndSec = endSec + ba;
    cursor = slotEndSec;
    return {
      slotStartSec,
      startSec,
      endSec,
      slotEndSec,
      // not bb + dur + ba: a lead the clamp above took back (a 0:00 row above, or one
      // longer than it) is not off this row's own length
      blockSeconds: slotEndSec - slotStartSec,
      accumulatedSec: cursor - showStartSec,
      overHardOut: foldedHardOutSec != null ? slotEndSec > foldedHardOutSec : false,
    };
  });
  // "เล่นซ้อน" (runSecondsOf below): a row the next one comes in over ENDS when it comes
  // in - its end, block and running total stop there, and the next row's block is its
  // own length in full. The overlap used to come off the NEXT row instead (A 4:00, then
  // B 3:20 at -5: A read "จบ 4:00 · สะสม 4:00", B a 3:15 block) - the same show end, but
  // every row the overlap touched read the full song.
  // A WAIT before the next row (a positive buffer_before) is this row's too, the way Live
  // Mode counts it: its countdown runs on, silent, until the next one comes in.
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (next.startSec === row.slotEndSec) continue;
    row.slotEndSec = next.startSec;
    row.endSec = Math.min(row.endSec, next.startSec);
    row.blockSeconds = row.slotEndSec - row.slotStartSec;
    row.accumulatedSec = row.slotEndSec - showStartSec;
    row.overHardOut = foldedHardOutSec != null ? row.slotEndSec > foldedHardOutSec : false;
    next.slotStartSec = next.startSec;
    next.blockSeconds = next.slotEndSec - next.slotStartSec;
  }

  const totalSeconds = cursor - showStartSec;
  return {
    rows,
    totalSeconds,
    endSec: cursor,
    hardOutSec: foldedHardOutSec,
    overBy: foldedHardOutSec != null ? Math.max(0, cursor - foldedHardOutSec) : 0,
    isOver: foldedHardOutSec != null && cursor > foldedHardOutSec,
  };
}

/**
 * Today's date as "YYYY-MM-DD" pinned to Asia/Bangkok. CueIQ is a
 * Thailand-only label; using the runtime's local date breaks on Vercel
 * (UTC) between 00:00-06:59 Bangkok time — "today" would still read as
 * yesterday there, showing yesterday's show as upcoming / stamping
 * exports with the wrong date.
 */
export function bkkTodayKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(
    date
  );
}

/**
 * The same calendar day one month earlier, as "YYYY-MM-DD" — clamped to the end
 * of a shorter month (03-31 → 02-28), never rolled forward into the next one the
 * way `setMonth(m - 1)` does (03-31 → 03-03). String in, string out: hand it
 * bkkTodayKey() and the cutoff is a Bangkok date, not a UTC one.
 */
export function monthBeforeKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const daysInPm = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${py}-${pad(pm)}-${pad(Math.min(d, daysInPm))}`;
}
