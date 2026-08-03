import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildRunSheetWorkbook,
  micBaseRows,
  performingMembers,
  type ExportData,
} from "@/lib/export-excel";
import type { Member, MicAssignment } from "@/lib/types";

function member(over: Partial<Member> & { id: string; name: string }): Member {
  return {
    tenant_id: "t1",
    group_id: "g1",
    nickname: null,
    mic_number: null,
    color: null,
    sort_order: 0,
    created_at: "2026-01-01",
    ...over,
  };
}

const BAND: Member[] = [
  member({ id: "m1", name: "Nutthapat", nickname: "ก้อง", mic_number: 1, sort_order: 0 }),
  member({ id: "m2", name: "Fah", nickname: "ฟ้า", mic_number: 2, sort_order: 1 }),
  member({ id: "m3", name: "Mint", nickname: "มิ้น", mic_number: 1, sort_order: 2 }),
  member({ id: "m4", name: "No Mic", sort_order: 3 }),
];

function data(over: Partial<ExportData> = {}): ExportData {
  return {
    event: {
      name: "Show A",
      event_date: "2026-08-09",
      venue: "Hall",
      show_start_time: "19:00:00",
      hard_out_time: null,
      notes: null,
      costume_theme: null,
    },
    schedule: [],
    setlist: [],
    micMap: [],
    members: BAND,
    lineup: [],
    ...over,
  };
}

/** Every cell of a sheet as an array-of-arrays of strings, like a printout. */
function rows(wb: XLSX.WorkBook, sheet: string): string[][] {
  const ws = wb.Sheets[sheet];
  expect(ws, `sheet "${sheet}" is missing`).toBeDefined();
  return (
    XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false }) as unknown[][]
  ).map((r) => (r ?? []).map((c) => (c == null ? "" : String(c))));
}

const flat = (wb: XLSX.WorkBook, sheet: string) => rows(wb, sheet).flat().join("\n");

describe("performingMembers", () => {
  it("an empty lineup means the whole band (0006's own rule)", () => {
    expect(performingMembers(BAND, [])).toEqual(BAND);
  });

  it("keeps band order, not lineup order", () => {
    expect(performingMembers(BAND, ["m3", "m1"]).map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("ignores ids that are no longer members", () => {
    expect(performingMembers(BAND, ["m2", "deleted"]).map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("micBaseRows", () => {
  it("prefers the event's own mic_assignments", () => {
    const micMap: MicAssignment[] = [
      {
        id: "a2",
        tenant_id: "t1",
        event_id: "e1",
        mic_number: 1,
        holder_name: "Second",
        order_index: 1,
        created_at: "",
      },
      {
        id: "a1",
        tenant_id: "t1",
        event_id: "e1",
        mic_number: 1,
        holder_name: "First",
        order_index: 0,
        created_at: "",
      },
    ];
    expect(micBaseRows(micMap, BAND)).toEqual([[1, "First, Second"]]);
  });

  // The bug this file exists for: 40 of 41 production events have no
  // mic_assignments at all and used to print a Mic Map with a bare header.
  it("falls back to the members' own mic numbers, sorted, grouped, band-ordered", () => {
    expect(micBaseRows([], BAND)).toEqual([
      [1, "ก้อง, มิ้น"],
      [2, "ฟ้า"],
    ]);
  });

  it("the fallback only covers who is actually performing", () => {
    expect(micBaseRows([], performingMembers(BAND, ["m2", "m4"]))).toEqual([[2, "ฟ้า"]]);
  });

  it("falls back to the full name when a member has no nickname", () => {
    const m = member({ id: "x", name: "Full Name", nickname: "  ", mic_number: 3 });
    expect(micBaseRows([], [m])).toEqual([[3, "Full Name"]]);
  });

  it("is empty only when there is genuinely nothing to place", () => {
    expect(micBaseRows([], [member({ id: "x", name: "No Mic" })])).toEqual([]);
  });
});

describe("buildRunSheetWorkbook", () => {
  it("ships a Lineup sheet alongside the other three", () => {
    expect(buildRunSheetWorkbook(data()).SheetNames).toEqual([
      "Run Sheet",
      "Schedule",
      "Lineup",
      "Mic Map",
    ]);
  });

  it("marks who is in and who is out", () => {
    const wb = buildRunSheetWorkbook(data({ lineup: ["m1", "m2"] }));
    const sheet = rows(wb, "Lineup");
    const byName = Object.fromEntries(
      sheet.filter((r) => r[3]).map((r) => [r[3], r[4]])
    );
    expect(byName["Nutthapat"]).toBe("มา");
    expect(byName["Fah"]).toBe("มา");
    expect(byName["Mint"]).toBe("ไม่มา");
    expect(byName["No Mic"]).toBe("ไม่มา");
    expect(flat(wb, "Lineup")).toContain("2/4 คน");
  });

  it("an unchosen lineup counts everyone in, and says so", () => {
    const text = flat(buildRunSheetWorkbook(data()), "Lineup");
    expect(text).toContain("ยังไม่ได้เลือก");
    expect(text.match(/ไม่มา/g)).toBeNull();
  });

  it("names the performers on the Run Sheet header too", () => {
    const text = flat(buildRunSheetWorkbook(data({ lineup: ["m2"] })), "Run Sheet");
    expect(text).toContain("ไลน์อัพ");
    expect(text).toContain("1/4 คน — ฟ้า");
  });

  it("the Mic Map is never a bare header", () => {
    // no mic_assignments — the 40-of-41 case
    expect(flat(buildRunSheetWorkbook(data()), "Mic Map")).toContain("ก้อง, มิ้น");
    // nothing to place at all: an explanation, not an empty table
    const bare = buildRunSheetWorkbook(
      data({ members: [member({ id: "x", name: "No Mic" })], lineup: [] })
    );
    expect(flat(bare, "Mic Map")).toContain("ยังไม่ได้ตั้งไมค์");
  });

  it("a band with no members in the system still exports", () => {
    const wb = buildRunSheetWorkbook(data({ members: [], lineup: [] }));
    expect(flat(wb, "Lineup")).toContain("ยังไม่มีสมาชิก");
    // and the run-sheet header drops the ไลน์อัพ line rather than printing "0 คน"
    expect(flat(wb, "Run Sheet")).not.toContain("ไลน์อัพ");
  });
});
