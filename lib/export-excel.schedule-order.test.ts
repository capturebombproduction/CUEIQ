import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildRunSheetWorkbook, type ExportData } from "@/lib/export-excel";
import type { ScheduleItem } from "@/lib/types";

// 2026-10-27 (hunt 6): the workbook's Schedule sheet lists the day in the order the
// in-app run sheet (and its JPG) reads it - round the stage, a row with no time last,
// ties as the band ordered them. Both readers (the web ExportButton's query and the
// desktop bundle) hand the rows over in sort_order, the order they were ADDED, and the
// sheet printed them like that: a day built Stage-first read Stage 18:00 above Call
// 16:00, and a 00:30 booth after a 23:00 set at the top.

function row(over: Partial<ScheduleItem> & { id: string; sort_order: number }): ScheduleItem {
  return {
    tenant_id: "t1",
    event_id: "e1",
    kind: "other",
    label: null,
    location: null,
    start_time: null,
    end_time: null,
    notes: null,
    ...over,
  };
}

function data(schedule: ScheduleItem[], showStart: string | null): ExportData {
  return {
    event: {
      name: "Show A",
      event_date: "2026-08-09",
      venue: "Hall",
      show_start_time: showStart,
      hard_out_time: null,
      notes: null,
      costume_theme: null,
    },
    schedule,
    setlist: [],
    micMap: [],
    members: [],
    lineup: [],
  };
}

/** The Schedule sheet's หัวข้อ column, top to bottom, under its header row. */
function labels(d: ExportData): string[] {
  const ws = buildRunSheetWorkbook(d).Sheets["Schedule"];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false }) as unknown[][];
  const head = all.findIndex((r) => r?.[0] === "#");
  return all.slice(head + 1).map((r) => String(r?.[2] ?? ""));
}

describe("Run sheet workbook · the Schedule sheet in the day's order", () => {
  it("earliest first, whatever order the rows were added in", () => {
    const schedule = [
      row({ id: "a", sort_order: 1, kind: "stage", label: "ขึ้นเวที", start_time: "18:00:00" }),
      row({ id: "b", sort_order: 2, kind: "on_location", label: "นัดรวม", start_time: "16:00:00" }),
      row({ id: "c", sort_order: 3, kind: "photo", label: "ถ่ายรูป", start_time: "17:00:00" }),
    ];
    expect(labels(data(schedule, "18:00:00"))).toEqual(["นัดรวม", "ถ่ายรูป", "ขึ้นเวที"]);
  });

  it("an after-midnight booth after a late set is the END of the day, and an untimed row is last", () => {
    const schedule = [
      row({ id: "a", sort_order: 1, kind: "booth", label: "บูธ", start_time: "00:30:00" }),
      row({ id: "b", sort_order: 2, label: "โน้ตทั่วไป" }),
      row({ id: "c", sort_order: 3, kind: "stage", label: "ขึ้นเวที", start_time: "23:00:00" }),
      row({ id: "d", sort_order: 4, kind: "on_location", label: "นัดรวม", start_time: "21:00:00" }),
    ];
    expect(labels(data(schedule, "23:00:00"))).toEqual(["นัดรวม", "ขึ้นเวที", "บูธ", "โน้ตทั่วไป"]);
  });

  it("rows at the same time keep the band's own order", () => {
    const schedule = [
      row({ id: "z", sort_order: 2, label: "สอง", start_time: "15:00:00" }),
      row({ id: "y", sort_order: 1, label: "หนึ่ง", start_time: "15:00:00" }),
    ];
    expect(labels(data(schedule, "18:00:00"))).toEqual(["หนึ่ง", "สอง"]);
  });
});
