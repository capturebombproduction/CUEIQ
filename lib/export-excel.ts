import * as XLSX from "xlsx";
import {
  SCHEDULE_KIND_LABELS,
  SETLIST_KIND_SHORT,
  type EventRow,
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
    "name" | "event_date" | "venue" | "show_start_time" | "hard_out_time"
  >;
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "run-sheet";
}

function micSlotsText(it: SetlistItem): string {
  return (it.mic_slots ?? [])
    .map((s) => `${s.mic}→${s.member}`)
    .join(", ");
}

export function buildRunSheetWorkbook(data: ExportData): XLSX.WorkBook {
  const { event, schedule, setlist, micMap } = data;
  const showStartSec = parseClockToSeconds(event.show_start_time);
  const hardOutSec = parseClockToSeconds(event.hard_out_time);
  const hasClock = showStartSec != null;
  const timing = computeSetlistTimes(setlist, showStartSec ?? 0, hardOutSec);

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
                  Math.max(0, hardOutSec - timing.endSec)
                )}`,
          ],
        ];

  const runSheet = XLSX.utils.aoa_to_sheet([
    ...runHeader,
    runCols,
    ...runRows,
    ...hardOutLine,
  ]);
  runSheet["!cols"] = [
    { wch: 4 },
    { wch: 7 },
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

  // ---- Mic Map ----
  const micGroups = new Map<number, MicAssignment[]>();
  for (const m of micMap) {
    const arr = micGroups.get(m.mic_number) ?? [];
    arr.push(m);
    micGroups.set(m.mic_number, arr);
  }
  const micBaseRows = Array.from(micGroups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([num, holders]) => [
      num,
      holders
        .sort((a, b) => a.order_index - b.order_index)
        .map((h) => h.holder_name)
        .filter(Boolean)
        .join(", "),
    ]);

  const micPerSong = setlist
    .filter((s) => (s.mic_slots?.length ?? 0) > 0)
    .map((s) => [s.title, micSlotsText(s)]);

  const micSheet = XLSX.utils.aoa_to_sheet([
    ["Mic Map (ฐาน)"],
    ["ไมค์", "สมาชิก (ตามลำดับวนไมค์)"],
    ...micBaseRows,
    [],
    ["Mic Map แยกตามเพลง"],
    ["เพลง/หัวข้อ", "ไมค์ → สมาชิก"],
    ...micPerSong,
  ]);
  micSheet["!cols"] = [{ wch: 22 }, { wch: 40 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, runSheet, "Run Sheet");
  XLSX.utils.book_append_sheet(wb, scheduleSheet, "Schedule");
  XLSX.utils.book_append_sheet(wb, micSheet, "Mic Map");
  return wb;
}

export function downloadRunSheet(data: ExportData) {
  const wb = buildRunSheetWorkbook(data);
  XLSX.writeFile(wb, `${sanitize(data.event.name)} - RunSheet.xlsx`);
}
