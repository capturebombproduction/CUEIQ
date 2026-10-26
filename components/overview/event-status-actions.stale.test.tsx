// Approving from a STALE Overview used to approve whatever the row was by then.
//
// The Overview never re-reads (no poll, no router.refresh - overview-client.tsx), and
// EventStatusActions holds the status it was rendered with (useState(initialStatus)).
// Its write is `update({ status: next }).eq("id", eventId)` (event-status-actions.tsx:
// 67-72) - no precondition on the status the dialog SHOWED. Meanwhile the band's Ar
// edits the show and event-workspace's auto-transition pulls it back to "draft" because
// a required item went missing (event-workspace.tsx:177). The approver, on a board
// opened earlier, sees "รออนุมัติ", taps อนุมัติ - and an incomplete DRAFT becomes
// "approved": the band gets "✅ อนุมัติงานแล้ว", and the board then hides its
// "ยังขาด N" chip (ReadyBadge returns null for approved) and drops it from the
// "ยังเตรียมไม่ครบ" tile, so the missing item is no longer flagged anywhere.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, notify: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventStatusActions } from "@/components/overview/event-status-actions";

// The row in the DB is "draft" now. An update that is conditioned on the status the
// dialog showed ("pending_review") matches nothing; an unconditioned one lands.
const SERVER_STATUS = "draft";
let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      events: (call: RecordedCall) => {
        const want = call.eq.status;
        if (want !== undefined && want !== SERVER_STATUS) return ok([]);
        return ok([{ id: "e1" }]);
      },
    },
    session: null,
  });
  h.supa = supa;
  h.notify.mockReset();
});

describe("approve on a stale board", () => {
  it("does not approve a show that left รออนุมัติ after the board was loaded", async () => {
    render(<EventStatusActions eventId="e1" eventName="Sourgrumy" initialStatus="pending_review" />);
    fireEvent.click(screen.getByTitle(/แตะเพื่อเปลี่ยนสถานะ/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /อนุมัติ/ }));
    });
    const upd = supa.callsTo("events", "update");
    expect(upd).toHaveLength(1);
    // the band must not be told a draft was approved
    expect(h.notify).not.toHaveBeenCalledWith("event_approved", { eventId: "e1" });
  });
});
