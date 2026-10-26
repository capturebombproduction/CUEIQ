// A delete that removed nothing used to be announced as done.
//
// DeleteEventButton sent `.delete().eq("id", eventId)` with no `.select()`, so a delete
// that RLS filtered to zero rows — sent as anon after a failed token refresh (the state
// lib/write-guard.ts exists for), or by an Ar whose band role was just removed — came
// back { error: null }: the card was dropped on the spot and the toast said ลบงานแล้ว.
// The show was still there; it returned on the next refresh, or (anon refresh) stayed
// hidden from this device until a reload. The mic map's two deletes had the same shape:
// the holder / mic vanished from the tab and was still on the server for everyone else.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import type { MicAssignment } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("@/lib/mgmt-write", () => ({
  OFFLINE_QUEUED_MESSAGE: "queued",
  tryQueueChildList: vi.fn(async () => false),
  // nothing waits in an offline queue here (the web): every edit writes online
  QUEUED_BEHIND_PENDING_MESSAGE: "queued behind",
  tryQueueBehindPendingChildList: vi.fn(async () => false),
}));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError, info: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }),
}));
// The (type-to-)confirm dialog is not what is under test: say yes.
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));

import { DeleteEventButton } from "@/components/event/delete-event-button";
import { MicMapEditor } from "@/components/event/mic-map-editor";

let supa: SupabaseFake;
beforeEach(() => {
  h.toastSuccess.mockClear();
  h.toastError.mockClear();
});

const deletes = (table: string) => supa.calls.filter((c) => c.table === table && c.verb === "delete");

describe("DeleteEventButton", () => {
  async function pressDelete(onDeleted = vi.fn()) {
    render(<DeleteEventButton eventId="e1" eventName="งานทดสอบ" onDeleted={onDeleted} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("ลบงานนี้"));
    });
    await waitFor(() => expect(deletes("events")).toHaveLength(1));
    await act(async () => {});
    return onDeleted;
  }

  it("a delete that touched no row is not reported as deleted, and the card stays", async () => {
    supa = makeSupabaseFake({ script: { events: ok([]) } });
    h.supa = supa;
    const onDeleted = await pressDelete();
    expect(h.toastSuccess).not.toHaveBeenCalledWith("ลบงานแล้ว");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith("ยังไม่ได้ลบงาน", expect.anything());
    expect(screen.getByTitle("ลบงานนี้")).not.toBeDisabled();
  });

  // 2026-10-27: PostgREST's error is a plain object, not an Error - the toast dropped its
  // message, so a refusal (a guard trigger, a dead network) said "ไม่สำเร็จ" with no reason.
  it("a delete the server refused says why", async () => {
    supa = makeSupabaseFake({ script: { events: fail("เหตุผลจากเซิร์ฟเวอร์") } });
    h.supa = supa;
    const onDeleted = await pressDelete();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith("ลบงานไม่สำเร็จ", { description: "เหตุผลจากเซิร์ฟเวอร์" });
  });

  it("a delete that removed the show still says so and drops the card", async () => {
    supa = makeSupabaseFake({ script: { events: ok([{ id: "e1" }]) } });
    h.supa = supa;
    const onDeleted = await pressDelete();
    expect(h.toastSuccess).toHaveBeenCalledWith("ลบงานแล้ว");
    expect(onDeleted).toHaveBeenCalledWith("e1");
  });
});

describe("MicMapEditor · removing", () => {
  const holder = (id: string, num: number, name: string, order: number): MicAssignment => ({
    id, tenant_id: "t1", event_id: "e1", mic_number: num, holder_name: name, order_index: order,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const mount = () =>
    render(
      <MicMapEditor
        eventId="e1"
        tenantId="t1"
        eventName="งานทดสอบ"
        editable
        initialMics={[holder("a1", 1, "Aya", 1), holder("a2", 2, "Mei", 1)]}
        members={[]}
        lineup={[]}
        setlist={[]}
      />
    );

  it("a holder the server did not remove comes back, with a reason", async () => {
    supa = makeSupabaseFake({ script: { mic_assignments: ok([]) } });
    h.supa = supa;
    mount();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("เอา Aya ออกจากไมค์ 1"));
    });
    await waitFor(() => expect(deletes("mic_assignments")).toHaveLength(1));
    await act(async () => {});
    expect(h.toastError).toHaveBeenCalledWith("ยังไม่ได้ลบ", expect.anything());
    expect(screen.getByLabelText("เอา Aya ออกจากไมค์ 1")).toBeTruthy();
  });

  it("a mic the server did not remove comes back, with a reason", async () => {
    supa = makeSupabaseFake({ script: { mic_assignments: ok([]) } });
    h.supa = supa;
    mount();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("ลบไมค์ 2"));
    });
    await waitFor(() => expect(deletes("mic_assignments")).toHaveLength(1));
    await act(async () => {});
    expect(h.toastError).toHaveBeenCalledWith("ยังไม่ได้ลบ", expect.anything());
    expect(screen.getByLabelText("ลบไมค์ 2")).toBeTruthy();
  });

  it("a holder the server did remove stays gone, quietly", async () => {
    supa = makeSupabaseFake({ script: { mic_assignments: ok([{ id: "a1" }]) } });
    h.supa = supa;
    mount();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("เอา Aya ออกจากไมค์ 1"));
    });
    await waitFor(() => expect(deletes("mic_assignments")).toHaveLength(1));
    await act(async () => {});
    expect(h.toastError).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("เอา Aya ออกจากไมค์ 1")).toBeNull();
  });
});
