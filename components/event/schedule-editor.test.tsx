// The call sheet — the screen three of the label's five pieces of feedback are about.
//
// Each test below stands for one of them, in the reporter's own words:
//  · "งานมี 2 ชุด ถ่ายทั้ง 2 ชุด แต่สร้าง photo session ได้แค่ 1 อัน" (2026-08-15)
//  · "อยากให้บันทึกการแก้ไขไว้ตั้งแต่ไม่ต้องกดบันทึก" (2026-08-13) — the app already
//    did, and said nothing, which is why it was asked for
//  · "แก้ไขตารางเวลาไม่ได้" (2026-06-27) — by design, but the app never said so;
//    that one is covered in event-workspace's own test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import type { ScheduleItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
// The offline queue is a different story with its own tests; here it must simply
// never swallow a write, or "did it save" would be answered by the wrong module.
vi.mock("@/lib/mgmt-write", () => ({
  OFFLINE_QUEUED_MESSAGE: "queued",
  tryQueueChildList: vi.fn(async () => false),
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "./schedule-editor";

const EVENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

const row = (id: string, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id,
  tenant_id: TENANT,
  event_id: EVENT,
  kind: "photo",
  label: null,
  location: null,
  start_time: null,
  end_time: null,
  notes: null,
  sort_order: 1,
  ...over,
});

let supa: SupabaseFake;

function mount(items: ScheduleItem[], editable = true) {
  // ConfirmProvider because the editor's delete path asks through the shared
  // dialog — the app mounts one in its layout, so a test without it fails on a
  // hook that has nothing to do with what is being tested.
  return render(
    <ConfirmProvider>
      <ScheduleEditor
        eventId={EVENT}
        tenantId={TENANT}
        eventName="งานทดสอบ"
        initialItems={items}
        editable={editable}
      />
    </ConfirmProvider>
  );
}

beforeEach(() => {
  supa = makeSupabaseFake({ script: { schedule_items: ok([{ id: "new-row" }]) } });
  h.supa = supa;
});

describe("ScheduleEditor · a second photo round", () => {
  it("names the second round instead of refusing it", async () => {
    // Mig 0036 capped an event at ONE photo row and this button used to reject the
    // press outright. 0042 allows several, keyed on the trimmed name — so the row
    // has to arrive WITH a name, or the insert would collide on the empty one and
    // the band would be told their own button press was a duplicate.
    supa.setScript({ schedule_items: ok(row("row-2", { label: "รอบ 2", sort_order: 2 })) });
    mount([row("row-1", { label: "ถ่ายรูป" })]);

    const add = screen.getByRole("button", { name: /ถ่ายรูป/ });
    await act(async () => {
      fireEvent.click(add);
    });

    const insert = supa.calls.find((c) => c.verb === "insert");
    expect(insert).toBeTruthy();
    expect(insert!.values).toMatchObject({ kind: "photo", label: "รอบ 2" });
  });

  it("leaves the FIRST photo round unnamed, so both devices still collide on one key", async () => {
    // The race mig 0036 was written for: the Overview cell and this editor both
    // create "the" photo row. They must keep landing on the same unique key —
    // which is the unnamed/"ถ่ายรูป" one — or the duplicate rows come back.
    supa.setScript({ schedule_items: ok(row("row-1")) });
    mount([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ถ่ายรูป/ }));
    });
    const insert = supa.calls.find((c) => c.verb === "insert");
    expect(insert!.values).toMatchObject({ kind: "photo" });
    expect((insert!.values as Record<string, unknown>).label).toBeUndefined();
  });
});

describe("ScheduleEditor · the receipt", () => {
  it("says บันทึกแล้ว after an edit lands", async () => {
    mount([row("row-1", { kind: "stage", label: "ขึ้นเวที" })]);
    supa.setScript({ schedule_items: ok([{ id: "row-1" }]) });

    const location = screen.getAllByRole("textbox")[0];
    await act(async () => {
      fireEvent.change(location, { target: { value: "เวทีใหญ่" } });
      fireEvent.blur(location);
    });

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "saved")
    );
  });

  it("says ยังไม่ได้บันทึก when the write is REFUSED — and keeps saying it", async () => {
    // The toast is gone in seconds. What stays on screen has to keep telling the
    // truth, because the whole point is someone deciding it is safe to walk away.
    mount([row("row-1", { kind: "stage", label: "ขึ้นเวที" })]);
    supa.setScript({ schedule_items: fail("permission denied", 403) });

    const location = screen.getAllByRole("textbox")[0];
    await act(async () => {
      fireEvent.change(location, { target: { value: "เวทีใหญ่" } });
      fireEvent.blur(location);
    });

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "failed")
    );
  });

  it("a write that reported no error but touched NO ROW is a failure, not a save", async () => {
    // lib/write-guard.ts's class, on the receipt: an anon-degraded update returns
    // 200 with [] and nothing changed. Calling that "บันทึกแล้ว" would be the most
    // dangerous line this component could print.
    mount([row("row-1", { kind: "stage", label: "ขึ้นเวที" })]);
    supa.setScript({ schedule_items: ok([]) });

    const location = screen.getAllByRole("textbox")[0];
    await act(async () => {
      fireEvent.change(location, { target: { value: "เวทีใหญ่" } });
      fireEvent.blur(location);
    });

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "failed")
    );
  });
});

// Phone layout (2026-09-28): location / notes fold behind "+ สถานที่ / โน้ต" when a
// row has neither — they are filled on 10% / 6% of real rows but each took a full
// line on every card. jsdom has no layout, so what is pinned here is the one
// regression that would actually cost something: a value somebody TYPED being
// folded out of sight. The look itself was checked in a real browser at 390px.
describe("ScheduleEditor · folding the rarely-used fields on a phone", () => {
  const folded = (input: HTMLElement) =>
    input.closest("div.space-y-1")!.className.split(" ").includes("hidden");

  it("never folds a location or a note that has a value", () => {
    mount([
      row("a", { kind: "stage", location: "Main Stage" }),
      row("b", { kind: "booth", notes: "ของแจก 200 ชิ้น", sort_order: 2 }),
    ]);
    expect(folded(screen.getByDisplayValue("Main Stage"))).toBe(false);
    expect(folded(screen.getByDisplayValue("ของแจก 200 ชิ้น"))).toBe(false);
    expect(screen.queryByRole("button", { name: /\+ สถานที่ \/ โน้ต/ })).toBeNull();
  });

  it("folds them on an empty row, and one tap brings them back", () => {
    mount([row("a", { kind: "stage" })]);
    const locations = () => screen.getAllByPlaceholderText("e.g. Main Stage");
    expect(folded(locations()[0])).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /\+ สถานที่ \/ โน้ต/ }));
    expect(folded(locations()[0])).toBe(false);
  });
});

// Review 2026-09-28: a row open only BECAUSE it had a location folded itself away
// the moment that location was cleared — mid-edit, under the thumb — and the rest
// of the typing went nowhere.
describe("ScheduleEditor · a field being edited never folds away", () => {
  it("keeps location / notes open after the value that opened them is cleared", () => {
    mount([row("a", { kind: "stage", location: "Main Stage" })]);
    const input = screen.getByDisplayValue("Main Stage");
    fireEvent.change(input, { target: { value: "" } });
    const box = screen.getAllByPlaceholderText("e.g. Main Stage")[0].closest("div.space-y-1")!;
    expect(box.className.split(" ")).not.toContain("hidden");
    expect(screen.queryByRole("button", { name: /\+ สถานที่ \/ โน้ต/ })).toBeNull();
  });
});

// A member opens the Schedule tab to read the day, and used to get a grid of
// disabled fields in the order the rows were typed. Spec G.3: a call sheet — down
// the clock, one line a row, the stage marked — and nothing that looks pressable.
describe("ScheduleEditor · what a member reads", () => {
  it("is a timeline in clock order, not disabled fields", () => {
    mount(
      [
        row("stage", { kind: "stage", start_time: "18:00:00", end_time: "18:30:00", sort_order: 1 }),
        row("call", { kind: "on_location", start_time: "16:00:00", location: "ประตูหลัง", sort_order: 2 }),
        row("loose", { kind: "other", label: "รับของ", sort_order: 3 }),
      ],
      false
    );
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    const lines = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^16:00.*ถึงสถานที่.*ประตูหลัง/);
    expect(lines[1]).toMatch(/^18:0018:30.*ขึ้นเวที/);
    expect(lines[2]).toMatch(/รับของ/); // no time: kept, at the end
  });
});

// Review 2026-10-02 (CQ-02): on an iPad in portrait (640-892px) the three 44px reorder /
// delete buttons are 140px wide and the actions cell was 2/12 of the row — 86-128px — so
// with justify-end the overflow spilled LEFT over the End time field, and a tap on its
// clock icon landed on the ▲ button: it reordered the call sheet the crew reads, and saved.
// Measured in Chrome at 744 / 768 / 810 / 820 / 834: hit="เลื่อนขึ้น" on every one.
// jsdom has no layout, so what is pinned here is the ARITHMETIC that fixed it — the cell
// is 3/12 between sm and lg, the Label field gave the column up, and the row still adds
// to 12 on both sides of lg. The pixel claim (the hit test, the 1024-1280 desktop widths)
// is a real-browser measurement: review-shots/r15/tablet-portrait/p-sched3.js.
describe("ScheduleEditor · the reorder buttons stay off the End field (iPad portrait)", () => {
  // The col-span a cell gets in a tier: Tailwind is mobile-first, so the widest
  // breakpoint at or below the tier that names a span wins.
  const span = (el: Element, tier: "sm" | "lg") => {
    const tokens = el.className.split(/\s+/);
    const pick = (bp: string) => {
      const m = tokens.map((t) => t.match(new RegExp(`^${bp}:col-span-(\\d+)$`))).find(Boolean);
      return m ? Number(m[1]) : null;
    };
    const n = (tier === "lg" ? pick("lg") : null) ?? pick("sm");
    if (n == null) throw new Error(`no ${tier} col-span on "${el.className}"`);
    return n;
  };

  function firstRow() {
    mount([row("a", { kind: "stage", label: "Stage Round 1", start_time: "14:30:00", end_time: "15:30:00" })]);
    const cell = (el: Element) => el.closest("div.space-y-1")!;
    const [start, end] = Array.from(document.querySelectorAll("input[type=time]"));
    return {
      type: cell(screen.getByRole("combobox")),
      label: cell(screen.getByDisplayValue("Stage Round 1")),
      start: cell(start),
      end: cell(end),
      actions: screen.getByRole("button", { name: "เลื่อนขึ้น" }).parentElement!,
    };
  }

  it("gives the actions cell 3/12 between sm and lg, and the row still adds to 12 on both sides", () => {
    const r = firstRow();
    const sum = (tier: "sm" | "lg") =>
      span(r.type, tier) + span(r.label, tier) + span(r.start, tier) + span(r.end, tier) + span(r.actions, tier);
    // 3 x 44px buttons + 2 gaps = 140px. A 2/12 cell is 86-128px from 640 to 892px.
    expect(span(r.actions, "sm")).toBeGreaterThanOrEqual(3);
    expect(sum("sm")).toBe(12);
    // From lg up nothing moved: Label 3, actions 2, exactly the approved desktop row.
    expect(span(r.label, "lg")).toBe(3);
    expect(span(r.actions, "lg")).toBe(2);
    expect(sum("lg")).toBe(12);
  });

  it("if the buttons still do not fit, they overflow RIGHT (safe), never left over End", () => {
    const r = firstRow();
    // `justify-end` stays as the fallback for an engine that drops the `safe` keyword.
    expect(r.actions.className).toContain("justify-end");
    expect(r.actions.className).toContain("[justify-content:safe_flex-end]");
    // A time input has an intrinsic width; without this a narrow cell is sized by it.
    expect(r.start.className.split(" ")).toContain("min-w-0");
    expect(r.end.className.split(" ")).toContain("min-w-0");
  });
});
