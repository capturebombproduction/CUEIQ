// 2026-10-30, hunt 10 (mistakes-3): สถานะ changed in the event EDIT form told nobody. The
// Overview's chip (EventStatusActions) sends event_approved / event_rejected and the resubmit
// button (ApprovalControl) event_submitted - EventForm never called notify() at all. An admin who
// approved or rejected a show here left the band with no ✅ / ↩️ (prod: "Welcome to friendverse",
// approved with no verdict notice), and correcting an approval made by mistake left the band's
// last word "อนุมัติงานแล้ว". Now a status this form changed is told once the write has landed.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard } from "@/lib/dirty-guard";

const h = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
  notify: vi.fn(),
  queued: false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("@/lib/mgmt-write", () => ({
  QUEUED_BEHIND_PENDING_MESSAGE: "queued behind",
  saveEventWrite: vi.fn(async (args: { payload: Record<string, unknown>; eventId: string }) => {
    if (!h.queued) Object.assign(h.server, args.payload);
    return { ok: true, id: args.eventId, queued: h.queued };
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Radix Select cannot be driven in jsdom: a native <select> with the same contract
vi.mock("@/components/ui/select", () => {
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select data-select value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    );
  }
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  const SelectItem = ({ value }: { value: string }) => <option value={value}>{value}</option>;
  return { Select, SelectTrigger: Nothing, SelectValue: Nothing, SelectContent: Pass, SelectItem, SelectGroup: Pass };
});

import { EventForm } from "@/components/event/event-form";

const opened = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "Ichiban idol vol.26 Halloween", event_date: "2026-10-31",
  venue: "Hall", event_type: "idol", show_start_time: "17:40:00", hard_out_time: "18:00:00",
  status: "pending_review", notes: null, map_url: null, costume_theme: null,
  deadline: null, deadline_note: null, updated_at: "2026-10-29T00:00:00Z",
};

afterEach(() => {
  cleanup();
  resetDirtyGuard();
  h.notify.mockReset();
  h.server = {};
  h.queued = false;
});

async function saveWithStatus(from: string, to: string | null, canApprove = true) {
  const { container, getByRole, getByLabelText } = render(
    <ConfirmProvider>
      <EventForm mode="edit" tenantId="t1" userId="u1" canApprove={canApprove}
        groups={[{ id: "g1", name: "Seishin" } as never]} event={{ ...opened, status: from } as never} />
    </ConfirmProvider>
  );
  if (to) {
    const status = Array.from(container.querySelectorAll("select[data-select]")).find((s) =>
      s.querySelector('option[value="approved"]')
    ) as HTMLSelectElement;
    fireEvent.change(status, { target: { value: to } });
  } else {
    fireEvent.change(getByLabelText("สถานที่"), { target: { value: "New Hall" } });
  }
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "บันทึก" }));
  });
}

describe("EventForm — a status changed here is told like the Overview tells it", () => {
  it("approved by an approver: the band hears event_approved", async () => {
    await saveWithStatus("pending_review", "approved");
    expect(h.server.status).toBe("approved");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("event_approved", { eventId: "e1" });
  });

  it("rejected (an approval made by mistake, corrected here): the band hears event_rejected", async () => {
    await saveWithStatus("approved", "rejected");
    expect(h.notify).toHaveBeenCalledWith("event_rejected", { eventId: "e1" });
  });

  it("set to รออนุมัติ by the band's editor: the approvers hear event_submitted", async () => {
    await saveWithStatus("draft", "pending_review", false);
    expect(h.notify).toHaveBeenCalledWith("event_submitted", { eventId: "e1" });
  });

  it("back to Draft has no notice of its own", async () => {
    await saveWithStatus("approved", "draft");
    expect(h.server.status).toBe("draft");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("an edit that leaves the status alone tells nobody", async () => {
    await saveWithStatus("approved", null);
    expect(h.server.venue).toBe("New Hall");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a write only QUEUED on this device tells nobody yet (the server does not hold it)", async () => {
    h.queued = true;
    await saveWithStatus("pending_review", "approved");
    expect(h.notify).not.toHaveBeenCalled();
  });
});
