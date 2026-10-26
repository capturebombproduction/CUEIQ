// 2026-10-27 hunt (overview), a regression of c4388cf. The approve / reject write only
// goes over the status this screen SHOWED (.eq("status", prev)); when it finds the row
// moved on, the badge repainted to the real status but:
//  - the board was never told (onChanged), so its "รออนุมัติ N" chip and queue filter
//    kept counting a show that was already approved;
//  - a retry after a timed-out approve that DID land matched 0 rows, read "approved" and
//    said "สถานะงานนี้เปลี่ยนไปแล้ว" - and the band was never told it was approved.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  notify: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  server: "approved",
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("sonner", () => ({ toast: h.toast }));

import { EventStatusActions } from "@/components/overview/event-status-actions";

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      events: (call: RecordedCall) => {
        if (call.verb === "update") {
          // the conditional write lands only over the status the server still holds
          return call.eq.status === h.server ? ok([{ id: "e1" }]) : ok([]);
        }
        return ok({ status: h.server });
      },
    },
    session: null,
  });
  h.supa = supa;
  h.notify.mockReset();
  h.toast.success.mockReset();
  h.toast.error.mockReset();
});

async function approveFromPending(onChanged: (s: string) => void) {
  render(<EventStatusActions eventId="e1" eventName="X" initialStatus="pending_review" onChanged={onChanged} />);
  fireEvent.click(screen.getByTitle(/แตะเพื่อเปลี่ยนสถานะ/));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /อนุมัติ/ }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("EventStatusActions — the row moved on under the board", () => {
  it("already approved by another approver: it is done - the board is told, the band is NOT told again", async () => {
    // 2026-10-27 hunt: a board left open for hours re-sent "อนุมัติงานแล้ว" (the route's
    // dedupe is 5 minutes) - the approver who got there first already told the band
    h.server = "approved";
    const onChanged = vi.fn();
    await approveFromPending(onChanged);
    expect(supa.callsTo("events", "update")).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledWith("approved");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledWith("อนุมัติแล้ว");
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("moved somewhere else: says so, tells the board what the row holds, tells the band nothing", async () => {
    h.server = "rejected";
    const onChanged = vi.fn();
    await approveFromPending(onChanged);
    expect(h.toast.error.mock.calls[0]?.[0]).toBe("สถานะงานนี้เปลี่ยนไปแล้ว");
    expect(onChanged).toHaveBeenCalledWith("rejected");
    expect(h.notify).not.toHaveBeenCalled();
  });
});
