// mig 0042 allows several ถ่ายรูป rounds per event as long as each has its
// own NAME. The "+ ถ่ายรูป" button follows that, but the Type select still enforces 0036's
// old one-photo-per-event rule: a row already NAMED "ชุด 2" cannot be switched to ถ่ายรูป
// while "ชุด 1" exists — it is refused with the very advice ("ตั้งชื่อให้ต่างกัน") the
// band already followed, and nothing is written.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import type { ScheduleItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown, toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/mgmt-write", () => ({
  OFFLINE_QUEUED_MESSAGE: "queued",
  tryQueueChildList: vi.fn(async () => false),
  // nothing waits in an offline queue here (the web): every edit writes online
  QUEUED_BEHIND_PENDING_MESSAGE: "queued behind",
  tryQueueBehindPendingChildList: vi.fn(async () => false),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: h.toastError, info: vi.fn() } }));
// Radix Select cannot be driven in jsdom; a native <select> that calls onValueChange.
vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{ value?: string; onValueChange?: (v: string) => void }>({});
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>
    ),
    SelectTrigger: ({ id }: { id?: string }) => {
      const c = React.useContext(Ctx);
      return (
        <select data-testid={id} value={c.value} onChange={(e) => c.onValueChange?.(e.target.value)}>
          {["on_location", "dressing_room", "sound_check", "photo", "costume", "stb", "stage", "booth", "other"].map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      );
    },
    SelectValue: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
  };
});

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "@/components/event/schedule-editor";

const EVENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const row = (id: string, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id, tenant_id: TENANT, event_id: EVENT, kind: "photo", label: null, location: null,
  start_time: null, end_time: null, notes: null, sort_order: 1, ...over,
});

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ script: { schedule_items: ok([{ id: "row-2" }]) } });
  h.supa = supa;
  h.toastError.mockClear();
});

describe("ScheduleEditor · Type → ถ่ายรูป on a row that already has its own name", () => {
  it("switches the kind (0042 allows a second, differently-named round)", async () => {
    render(
      <ConfirmProvider>
        <ScheduleEditor
          eventId={EVENT}
          tenantId={TENANT}
          eventName="งานทดสอบ"
          editable
          initialItems={[
            row("row-1", { kind: "photo", label: "ชุด 1", sort_order: 1 }),
            row("row-2", { kind: "other", label: "ชุด 2", sort_order: 2 }),
          ]}
        />
      </ConfirmProvider>
    );
    const sel = screen.getByTestId("sc-row-2-kind") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(sel, { target: { value: "photo" } });
    });
    expect(h.toastError).not.toHaveBeenCalled();
    expect((screen.getByTestId("sc-row-2-kind") as HTMLSelectElement).value).toBe("photo");
  });

  it("still refuses a second UNNAMED round next to the unnamed one (0042's key collides)", async () => {
    render(
      <ConfirmProvider>
        <ScheduleEditor
          eventId={EVENT}
          tenantId={TENANT}
          eventName="งานทดสอบ"
          editable
          initialItems={[
            row("row-1", { kind: "photo", label: null, sort_order: 1 }),
            row("row-2", { kind: "other", label: "ถ่ายรูป", sort_order: 2 }),
          ]}
        />
      </ConfirmProvider>
    );
    await act(async () => {
      fireEvent.change(screen.getByTestId("sc-row-2-kind"), { target: { value: "photo" } });
    });
    expect(h.toastError).toHaveBeenCalledWith("ชื่อรอบถ่ายรูปซ้ำ", expect.anything());
    expect(supa.callsTo("schedule_items", "update")).toHaveLength(0);
  });
});
