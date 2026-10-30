// 2026-10-30, hunt 11: a show CREATED already as รออนุมัติ told nobody. Hunt 10 made a status the
// EDIT form changes notify (event-form.status-notify.test.tsx), but the create branch never called
// notify() - a band that created its show straight into รออนุมัติ left the approvers with no bell and
// no push, and with no "ส่งตรวจ" button to send it again. Now the create branch tells it the same way,
// once the write has landed.
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
    return { ok: true, id: args.eventId ?? "new-1", queued: h.queued };
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

afterEach(() => {
  cleanup();
  resetDirtyGuard();
  h.notify.mockReset();
  h.server = {};
  h.queued = false;
});

async function createWithStatus(to: string | null, canApprove = false) {
  const { container, getByRole, getByLabelText } = render(
    <ConfirmProvider>
      <EventForm mode="create" tenantId="t1" userId="u1" canApprove={canApprove}
        groups={[{ id: "g1", name: "Seishin" } as never]} />
    </ConfirmProvider>
  );
  fireEvent.change(getByLabelText("ชื่องาน *"), { target: { value: "Reborn into a new me" } });
  if (to) {
    const status = Array.from(container.querySelectorAll("select[data-select]")).find((s) =>
      s.querySelector('option[value="approved"]')
    ) as HTMLSelectElement;
    fireEvent.change(status, { target: { value: to } });
  }
  await act(async () => {
    fireEvent.click(getByRole("button", { name: /สร้างงาน/ }));
  });
}

describe("EventForm — a show created with a status that has a notice tells it", () => {
  it("created as รออนุมัติ by the band: the approvers hear event_submitted, once", async () => {
    await createWithStatus("pending_review");
    expect(h.server.status).toBe("pending_review");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("event_submitted", { eventId: "new-1" });
  });

  it("created as approved by an approver: the band hears event_approved", async () => {
    await createWithStatus("approved", true);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("event_approved", { eventId: "new-1" });
  });

  it("created as a draft (the default) tells nobody", async () => {
    await createWithStatus(null);
    expect(h.server.status).toBe("draft");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a create only QUEUED on this device tells nobody yet (the server does not hold it)", async () => {
    h.queued = true;
    await createWithStatus("pending_review");
    expect(h.notify).not.toHaveBeenCalled();
  });
});
