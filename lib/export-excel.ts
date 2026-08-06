import * as XLSX from "xlsx";
import {
  SCHEDULE_KIND_LABELS,
  SETLIST_KIND_SHORT,
  type EventRow,
  type Member,
  type MicAssignment,
  type ScheduleItem,
  type SetlistItem,
} from "@/lib/types";
import {
  computeSetlistTimes,
  formatClockOfDay,
  formatDuration,
  parseClockToSeconds,
  shortClock,
} from "@/lib/time";

export interface ExportData {
  event: Pick<
    EventRow,
    | "name"
    | "event_date"
    | "venue"
    | "show_start_time"
    | "hard_out_time"
    | "notes"
    | "costume_theme"
  >;
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  /** Every member of the band, in band order (members.sort_order). */
  members: Member[];
  /** member ids performing at THIS event (event_members). An EMPTY array means
   *  "ยังไม่ได้เลือก", which every other surface — the summary, the share page,
   *  0006_event_lineup.sql's own rule — renders as the whole band. */
  lineup: string[];
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "run-sheet";
}

function micSlotsText(it: SetlistItem): string {
  return (it.mic_slots ?? [])
    .map((s) => `${s.mic}→${s.member}`)
    .join(", ");
}

function displayName(m: Member): string {
  return m.nickname?.trim() || m.name;
}

/** Members performing at this event, in band order. Empty lineup = nobody has
 *  been picked yet, which reads as the whole band (see ExportData.lineup). */
export function performingMembers(members: Member[], lineup: string[]): Member[] {
  if (lineup.length === 0) return members;
  const inLineup = new Set(lineup);
  return members.filter((m) => inLineup.has(m.id));
}

/** Rows for the Mic Map's base table: [mic number, holders].
 *
 *  Prefers the per-event `mic_assignments` the Mic Map editor writes. Most events
 *  never open that editor — in production 40 of 41 have zero rows — and the sheet
 *  used to print as a bare header, so those fall back to each performing member's
 *  own default `mic_number`, which is what the app shows on screen anyway. */
export function micBaseRows(
  micMap: MicAssignment[],
  performing: Member[]
): (string | number)[][] {
  if (micMap.length > 0) {
    const micGroups = new Map<number, MicAssignment[]>();
    for (const m of micMap) {
      const arr = micGroups.get(m.mic_number) ?? [];
      arr.push(m);
      micGroups.set(m.mic_number, arr);
    }
    return Array.from(micGroups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([num, holders]) => [
        num,
        holders
          .sort((a, b) => a.order_index - b.order_index)
          .map((h) => h.holder_name)
          .filter(Boolean)
          .join(", "),
      ]);
  }
  // Fallback: the band's own mic numbers. Members with no mic number can't be
  // placed on a mic, so they are left to the Lineup sheet rather than invented
  // onto one. Band order inside a mic = the rotation order the app displays.
  const byMic = new Map<number, Member[]>();
  for (const m of performing) {
    if (m.mic_number == null) continue;
    const arr = byMic.get(m.mic_number) ?? [];
    arr.push(m);
    byMic.set(m.mic_number, arr);
  }
  return Array.from(byMic.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([num, holders]) => [num, holders.map(displayName).join(", ")]);
}

export function buildRunSheetWorkbook(data: ExportData): XLSX.WorkBook {
  const { event, schedule, setlist, micMap, members, lineup } = data;
  const performing = performingMembers(members, lineup);
  const lineupChosen = lineup.length > 0;
  const showStartSec = parseClockToSeconds(event.show_start_time);
  const hardOutSec = parseClockToSeconds(event.hard_out_time);
  const hasClock = showStartSec != null;
  const timing = computeSetlistTimes(setlist, showStartSec ?? 0, hardOutSec);

  // A multi-line โน้ต becomes one sheet row per line, label on the first only
  // (same shape as the summary's ApptList) — SheetJS community can't set
  // wrap-text, so a single cell would squash the whole note onto one line.
  const noteLines = (event.notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // ---- Run Sheet ----
  const runHeader: (string | number)[][] = [
    ["CueIQ — Run Sheet"],
    ["งาน", event.name],
    ["วันที่", event.event_date ?? "", "สถานที่", event.venue ?? ""],
    [
      "เริ่มโชว์",
      shortClock(event.show_start_time),
      "Hard Out",
      shortClock(event.hard_out_time),
    ],
    [
      "เวลารวม",
      formatDuration(timing.totalSeconds),
      "จบโดยประมาณ",
      hasClock ? formatClockOfDay(timing.endSec) : "",
    ],
    // ธีมชุด + โน้ต are typed on the event form and until now reached only the
    // on-screen summary and the share page — this workbook is what venue staff
    // actually hold, so it has to carry them too. Rows are dropped when empty,
    // like the summary's <Line/>, so a bare event keeps the same tight header.
    ...(event.costume_theme?.trim()
      ? [["ธีมชุด", event.costume_theme.trim()]]
      : []),
    // Who is actually on stage. The Lineup sheet carries the full table; this is
    // the one line a printed run sheet needs so nobody has to flip tabs.
    ...(members.length > 0
      ? [
          [
            "ไลน์อัพ",
            lineupChosen
              ? `${performing.length}/${members.length} คน — ${performing
                  .map(displayName)
                  .join(", ")}`
              : `ทั้งวง ${members.length} คน (ยังไม่ได้เลือกรายชื่อ)`,
          ],
        ]
      : []),
    ...noteLines.map((l, i) => [i === 0 ? "โน้ต" : "", l]),
    [],
  ];

  const runCols = [
    "#",
    "ประเภท",
    "ชื่อ/หัวข้อ",
    "เริ่ม",
    "จบ",
    "ความยาว",
    "Buf ก่อน(s)",
    "Buf หลัง(s)",
    "สะสม",
    "ไมค์",
    "โน้ต",
  ];
  const runRows = setlist.map((it, i) => {
    const t = timing.rows[i];
    return [
      i + 1,
      SETLIST_KIND_SHORT[it.kind] ?? it.kind,
      it.title,
      hasClock ? formatClockOfDay(t.startSec) : "",
      hasClock ? formatClockOfDay(t.endSec) : "",
      formatDuration(it.duration_seconds),
      it.buffer_before_seconds,
      it.buffer_after_seconds,
      formatDuration(t.accumulatedSec),
      micSlotsText(it),
      it.notes ?? "",
    ];
  });

  const hardOutLine =
    hardOutSec == null
      ? []
      : [
          [],
          [
            "สถานะ Hard Out",
            timing.isOver
              ? `เกิน ${formatDuration(timing.overBy)}`
              : `อยู่ในเวลา เหลือ ${formatDuration(
                  Math.max(0, timing.hardOutSec! - timing.endSec)
                )}`,
          ],
        ];

  const runSheet = XLSX.utils.aoa_to_sheet([
    ...runHeader,
    runCols,
    ...runRows,
    ...hardOutLine,
  ]);
  // A and B are wider than the table alone would need because the HEADER block
  // above the table shares them: the labels (วันที่ / เริ่มโชว์ / ธีมชุด / ไลน์อัพ)
  // sit in A and their values in B. At wch 4/7 Excel clipped "2026-08-09" to
  // "2026-0" and cut the Thai labels short — recoverable by dragging a column on
  // screen, unrecoverable once the sheet is printed and pinned to a board, which
  // is exactly what this file exists to produce.
  runSheet["!cols"] = [
    { wch: 10 },
    { wch: 12 },
    { wch: 28 },
    { wch: 7 },
    { wch: 7 },
    { wch: 8 },
    { wch: 10 },
    { wch: 10 },
    { wch: 8 },
    { wch: 26 },
    { wch: 30 },
  ];

  // ---- Schedule ----
  const scheduleSheet = XLSX.utils.aoa_to_sheet([
    ["ตารางนัดหมาย (Schedule)"],
    ["งาน", event.name],
    [],
    ["#", "ประเภท", "หัวข้อ", "สถานที่", "เริ่ม", "จบ", "โน้ต"],
    ...schedule.map((s, i) => [
      i + 1,
      SCHEDULE_KIND_LABELS[s.kind] ?? s.kind,
      s.label ?? "",
      s.location ?? "",
      shortClock(s.start_time),
      shortClock(s.end_time),
      s.notes ?? "",
    ]),
  ]);
  scheduleSheet["!cols"] = [
    { wch: 4 },
    { wch: 26 },
    { wch: 22 },
    { wch: 20 },
    { wch: 7 },
    { wch: 7 },
    { wch: 30 },
  ];

  // ---- Lineup ----
  // The whole band, with who is in and who is out, because "ไม่มา" is the fact a
  // stage manager needs as much as "มา". An unchosen lineup marks everyone in,
  // matching the summary badges and the share page.
  const lineupSheet = XLSX.utils.aoa_to_sheet([
    ["ไลน์อัพ (Lineup)"],
    ["งาน", event.name],
    [
      "มางานนี้",
      members.length === 0
        ? "วงนี้ยังไม่มีสมาชิกในระบบ"
        : lineupChosen
          ? `${performing.length}/${members.length} คน`
          : `ยังไม่ได้เลือก — นับทั้งวง ${members.length} คน`,
    ],
    [],
    ["#", "ไมค์", "ชื่อเล่น", "ชื่อ", "สถานะ"],
    ...members.map((m, i) => [
      i + 1,
      m.mic_number ?? "",
      m.nickname ?? "",
      m.name,
      !lineupChosen || lineup.includes(m.id) ? "มา" : "ไม่มา",
    ]),
  ]);
  lineupSheet["!cols"] = [
    { wch: 4 },
    { wch: 6 },
    { wch: 16 },
    { wch: 26 },
    { wch: 8 },
  ];

  // ---- Mic Map ----
  const baseRows = micBaseRows(micMap, performing);

  const micPerSong = setlist
    .filter((s) => (s.mic_slots?.length ?? 0) > 0)
    .map((s) => [s.title, micSlotsText(s)]);

  const micSheet = XLSX.utils.aoa_to_sheet([
    [
      "Mic Map (ฐาน)",
      micMap.length > 0 ? "" : "* จากไมค์ประจำตัวของสมาชิกที่มางานนี้",
    ],
    ["ไมค์", "สมาชิก (ตามลำดับวนไมค์)"],
    ...(baseRows.length > 0
      ? baseRows
      : [["—", "ยังไม่ได้ตั้งไมค์ และสมาชิกยังไม่มีเลขไมค์ประจำตัว"]]),
    [],
    ["Mic Map แยกตามเพลง"],
    ["เพลง/หัวข้อ", "ไมค์ → สมาชิก"],
    ...(micPerSong.length > 0
      ? micPerSong
      : [["—", "ไม่ได้ตั้งไมค์แยกรายเพลง"]]),
  ]);
  micSheet["!cols"] = [{ wch: 22 }, { wch: 40 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, runSheet, "Run Sheet");
  XLSX.utils.book_append_sheet(wb, scheduleSheet, "Schedule");
  XLSX.utils.book_append_sheet(wb, lineupSheet, "Lineup");
  XLSX.utils.book_append_sheet(wb, micSheet, "Mic Map");
  return wb;
}

export function downloadRunSheet(data: ExportData) {
  const wb = buildRunSheetWorkbook(data);
  XLSX.writeFile(wb, `${sanitize(data.event.name)} - RunSheet.xlsx`);
}
