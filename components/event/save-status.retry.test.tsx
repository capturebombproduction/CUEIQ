// A failed autosave belongs to the editor that made it, and goes away when that
// editor saves again.
//
// Before 2026-10-26 lib/dirty-guard.ts kept every failure for the whole session:
// a photo round named "ชุด 1" (taken — mig 0042's unique key, 23505), then renamed
// "ชุด 2" and saved fine, turned its own badge back to บันทึกแล้ว — while "บันทึก /
// อัปเดต" still answered ยังบันทึกไม่ครบ and every link out / tab close asked
// "มีการแก้ไขที่ยังบันทึกไม่สำเร็จ" over nothing lost.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { hasUnsavedWork, markPending, markSettled, resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";
import type { ScheduleItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown, toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/mgmt-write", () => ({ OFFLINE_QUEUED_MESSAGE: "queued", tryQueueChildList: vi.fn(async () => false) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: h.toastError, info: vi.fn() } }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { useSaveSignal } from "@/components/event/save-status";

const EVENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const row = (id: string, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id, tenant_id: TENANT, event_id: EVENT, kind: "photo", label: null, location: null,
  start_time: null, end_time: null, notes: null, sort_order: 1, ...over,
});

let supa: SupabaseFake;
beforeEach(() => {
  resetDirtyGuard();
  h.toastError.mockClear();
  supa = makeSupabaseFake({
    script: {
      // 1st label save: the name is taken (0042's unique index); 2nd: saved.
      schedule_items: [
        fail({ message: "duplicate key value violates unique constraint", code: "23505" }),
        ok([{ id: "row-2" }]),
      ],
    },
  });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  resetDirtyGuard();
});

describe("a photo round whose name was taken, then renamed", () => {
  it("stops counting as unsaved once the same field saves", async () => {
    render(
      <ConfirmProvider>
        <ScheduleEditor
          eventId={EVENT}
          tenantId={TENANT}
          eventName="งานทดสอบ"
          editable
          initialItems={[
            row("row-1", { label: "ชุด 1", sort_order: 1 }),
            row("row-2", { label: "รอบ 2", sort_order: 2 }),
          ]}
        />
      </ConfirmProvider>
    );
    const label = document.getElementById("sc-row-2-label") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(label, { target: { value: "ชุด 1" } });
      fireEvent.blur(label);
    });
    expect(h.toastError).toHaveBeenCalled();
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "failed");
    // the refusal really is held against leaving, while it stands
    expect(unsavedWork()).toEqual({ pending: 0, failed: 1 });

    await act(async () => {
      fireEvent.change(label, { target: { value: "ชุด 2" } });
      fireEvent.blur(label);
    });
    expect(supa.calls.filter((c) => c.table === "schedule_items" && c.verb === "update")).toHaveLength(2);
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "saved");
    // the badge and the leave-the-page warning now say the same thing
    expect(unsavedWork()).toEqual({ pending: 0, failed: 0 });
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe("whose failure it is", () => {
  let handles: Record<string, ReturnType<typeof useSaveSignal>> = {};
  function Editor({ id }: { id: string }) {
    handles[id] = useSaveSignal();
    return null;
  }
  beforeEach(() => {
    handles = {};
  });

  it("one editor saving does not take back ANOTHER editor's failure", () => {
    render(
      <>
        <Editor id="schedule" />
        <Editor id="setlist" />
      </>
    );
    act(() => {
      handles.schedule.begin();
      handles.schedule.end(false);
    });
    act(() => {
      handles.setlist.begin();
      handles.setlist.end(true);
    });
    expect(unsavedWork().failed).toBe(1);
  });

  it("a failure reported without an editor stays until the user is told", () => {
    render(<Editor id="schedule" />);
    markPending();
    markSettled(false);
    act(() => {
      handles.schedule.begin();
      handles.schedule.end(true);
    });
    expect(unsavedWork().failed).toBe(1);
  });

  it("a save still in flight beside the failure does not clear it", () => {
    render(<Editor id="schedule" />);
    act(() => {
      handles.schedule.begin();
      handles.schedule.begin();
      handles.schedule.end(false);
      handles.schedule.end(true); // the other write of the same batch
    });
    expect(unsavedWork().failed).toBe(1);
  });
});
