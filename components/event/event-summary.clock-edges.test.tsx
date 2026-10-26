// Two clock edges on the run sheet — the sheet that is printed and exported as the JPG.
//
// 1) A late show's day printed out of order. The timeline sorted by the raw
//    "HH:MM:SS" string, so for a 23:00 set called at 21:00 with a 00:30 booth (a
//    countdown / late festival slot — and lib/clone-event.ts WRAPS copied rows past
//    midnight) the booth came FIRST, above the call. The day is now read round the
//    stage, the rule lib/next-show.ts callTimeOf already used for the call time.
//
// 2) A hard out with no show start: computeSetlistTimes(setlist, 0, hardOut) ran the
//    set from 00:00, so a 20-min set against a 13:40 hard out printed a green
//    "Remaining 13:20:00" (and the Excel "อยู่ในเวลา เหลือ 13:20:00") — a claim about
//    a set whose start nobody entered.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventRow, Group, ScheduleItem, SetlistItem } from "@/lib/types";
import { buildRunSheetWorkbook } from "@/lib/export-excel";
import * as XLSX from "xlsx";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { EventSummary } from "@/components/event/event-summary";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
const base = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-31",
  venue: null, event_type: "idol", show_start_time: null, hard_out_time: null, status: "draft",
  notes: null, map_url: null, costume_theme: null, is_template: false, group,
};
const ev = (over: Partial<EventRow>) => ({ ...base, ...over }) as unknown as EventRow & { group: Group | null };
const sched = (id: string, kind: string, start: string | null, end: string | null = null, sort = 1) =>
  ({ id, tenant_id: "t1", event_id: "e1", kind, label: null, location: null, start_time: start,
    end_time: end, notes: null, sort_order: sort }) as ScheduleItem;
const song = (id: string, title: string, sec: number) =>
  ({ id, tenant_id: "t1", event_id: "e1", kind: "song", title, duration_seconds: sec,
    buffer_before_seconds: 0, buffer_after_seconds: 0, mic_slots: [], notes: null, sort_order: 1 }) as SetlistItem;

const mount = (event: EventRow & { group: Group | null }, schedule: ScheduleItem[], setlist: SetlistItem[]) =>
  render(
    <EventSummary event={event} schedule={schedule} setlist={setlist} members={[]} showMic
      onNavigate={() => {}} tenantId="t1" />
  );

const LATE_DAY = [
  sched("a", "on_location", "21:00:00", null, 1),
  sched("b", "stage", "23:00:00", "23:30:00", 2),
  sched("c", "booth", "00:30:00", "01:30:00", 3),
  sched("d", "other", null, null, 4),
];

const scheduleText = () => screen.getByText("Schedule").closest("section")!.textContent ?? "";
const positions = (text: string, words: string[]) => words.map((w) => text.indexOf(w));

describe("run sheet · a set that crosses midnight", () => {
  it("prints the day in the order it happens (call → stage → after-midnight booth)", () => {
    mount(ev({ show_start_time: "23:00:00", hard_out_time: "23:30:00" }), LATE_DAY, []);
    const [call, stage, booth] = positions(scheduleText(), ["21:00", "23:00–23:30", "00:30–01:30"]);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(stage);
    expect(stage).toBeLessThan(booth);
  });

  it("reads the day round the stage row when the show start is not set", () => {
    mount(ev({}), LATE_DAY, []);
    const [call, booth] = positions(scheduleText(), ["21:00", "00:30–01:30"]);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(booth);
  });

  it("an ordinary daytime show keeps its plain clock order", () => {
    mount(
      ev({ show_start_time: "13:00:00" }),
      [
        sched("s", "stage", "13:00:00", "13:20:00", 1),
        sched("o", "on_location", "11:00:00", null, 2),
        sched("b", "booth", "14:00:00", "15:00:00", 3),
      ],
      []
    );
    const [call, stage, booth] = positions(scheduleText(), ["11:00", "13:00–13:20", "14:00–15:00"]);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(stage);
    expect(stage).toBeLessThan(booth);
  });

  it("the members' call sheet (Schedule tab, read-only) reads the day the same way", () => {
    render(
      <ConfirmProvider>
        <ScheduleEditor eventId="e1" tenantId="t1" eventName="งานทดสอบ" editable={false} initialItems={LATE_DAY} />
      </ConfirmProvider>
    );
    const items = Array.from(document.querySelectorAll("ol > li")).map((li) => li.textContent ?? "");
    const at = (clock: string) => items.findIndex((t) => t.includes(clock));
    expect(items).toHaveLength(4);
    expect(at("21:00")).toBe(0);
    expect(at("23:00")).toBe(1);
    expect(at("00:30")).toBe(2); // the untimed row stays last
  });
});

describe("run sheet · hard out set, show start not", () => {
  it("does not claim a 13-hour 'Remaining'", () => {
    mount(ev({ show_start_time: null, hard_out_time: "13:40:00" }), [], [song("s1", "เพลง 1", 1200)]);
    expect(screen.queryByText(/Remaining/)).toBeNull();
    expect(screen.queryByText(/เกิน Hard Out/)).toBeNull();
  });

  it("still says Remaining once the show has a start", () => {
    mount(ev({ show_start_time: "13:00:00", hard_out_time: "13:40:00" }), [], [song("s1", "เพลง 1", 1200)]);
    expect(screen.getByText(/Remaining/).textContent).toContain("20:00");
  });

  it("(Excel) prints no hard-out status without a show start", () => {
    const wb = buildRunSheetWorkbook({
      event: ev({ show_start_time: null, hard_out_time: "13:40:00" }) as never,
      schedule: [], setlist: [song("s1", "เพลง 1", 1200)], micMap: [], members: [], lineup: [],
    });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Run Sheet"], { header: 1 });
    expect(rows.find((r) => r[0] === "สถานะ Hard Out")).toBeUndefined();
  });

  it("(Excel) prints no hard-out status for an empty set", () => {
    const wb = buildRunSheetWorkbook({
      event: ev({ show_start_time: "13:00:00", hard_out_time: "13:40:00" }) as never,
      schedule: [], setlist: [], micMap: [], members: [], lineup: [],
    });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Run Sheet"], { header: 1 });
    expect(rows.find((r) => r[0] === "สถานะ Hard Out")).toBeUndefined();
  });

  it("(Excel) a timed set still gets its status", () => {
    const wb = buildRunSheetWorkbook({
      event: ev({ show_start_time: "13:00:00", hard_out_time: "13:40:00" }) as never,
      schedule: [], setlist: [song("s1", "เพลง 1", 1200)], micMap: [], members: [], lineup: [],
    });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Run Sheet"], { header: 1 });
    expect(String(rows.find((r) => r[0] === "สถานะ Hard Out")?.[1])).toContain("20:00");
  });
});
