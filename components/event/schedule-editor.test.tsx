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
