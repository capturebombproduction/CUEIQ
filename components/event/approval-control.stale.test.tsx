// 2026-10-27 (hunt 3): "ส่งขออนุมัติอีกครั้ง" wrote pending_review over whatever the row
// held - no condition on the status. A page still showing "rejected" while staff had
// approved the show since dragged it back to รออนุมัติ, and paged every approver about
// it. The write is now conditional on the status this page SHOWED, as the approve /
// reject twin (EventStatusActions) has been since c4388cf; a 0-row answer reads the row
// and says what it is now.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { SupabaseFake, RecordedCall } from "@/test/fakes/supabase";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify-client", () => ({ notify }));

import { ApprovalControl } from "./approval-control";

let supa: SupabaseFake;
/** the events row's status on the server */
let serverStatus = "rejected";

function fake(session: ReturnType<typeof makeSession> | null = makeSession()) {
  supa = makeSupabaseFake({
    session,
    script: {
      events: (call: RecordedCall) => {
        if (call.verb === "update") {
          // PostgREST: only a row matching every eq() filter is updated - and an anon
          // request (no session) matches none (RLS)
          if (!session) return ok([]);
          if (call.eq.status !== undefined && call.eq.status !== serverStatus) return ok([]);
          serverStatus = (call.values as { status: string }).status;
          return ok([{ id: "e1" }]);
        }
        return ok({ status: serverStatus });
      },
    },
  });
  h.supa = supa;
}

beforeEach(() => {
  notify.mockClear();
  router.refresh.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => cleanup());

async function resubmit() {
  render(<ApprovalControl eventId="e1" status="rejected" canResubmit />);
  await userEvent.click(screen.getByRole("button", { name: /ส่งขออนุมัติอีกครั้ง/ }));
  await waitFor(() => expect(toast.success.mock.calls.length + toast.error.mock.calls.length).toBe(1));
}

describe("ApprovalControl · ส่งขออนุมัติอีกครั้ง from a page that may be stale", () => {
  it("staff approved it since: the show stays approved, nobody is paged, and the page says so", async () => {
    serverStatus = "approved";
    fake();
    await resubmit();
    expect(serverStatus).toBe("approved");
    expect(notify).not.toHaveBeenCalled();
    expect(supa.lastCall("events", "update")!.eq.status, "the write is conditional").toBe("rejected");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "สถานะงานนี้เปลี่ยนไปแล้ว",
      expect.objectContaining({ description: expect.stringContaining("Approved") })
    );
    expect(router.refresh, "the page catches up with the row").toHaveBeenCalled();
  });

  it("still rejected: resubmitted, and the approvers are told", async () => {
    serverStatus = "rejected";
    fake();
    await resubmit();
    expect(serverStatus).toBe("pending_review");
    expect(toast.success).toHaveBeenCalledWith("ส่งขออนุมัติอีกครั้งแล้ว 🟠");
    expect(notify).toHaveBeenCalledWith("event_submitted", { eventId: "e1" });
  });

  it("already resubmitted from another device: done, without paging the approvers twice", async () => {
    serverStatus = "pending_review";
    fake();
    await resubmit();
    expect(serverStatus).toBe("pending_review");
    expect(toast.success).toHaveBeenCalledWith("ส่งขออนุมัติอีกครั้งแล้ว 🟠");
    expect(toast.error).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still rejected but nothing written (an anon request): ยังไม่ได้บันทึก as before, nobody paged", async () => {
    serverStatus = "rejected";
    fake(null);
    await resubmit();
    expect(serverStatus).toBe("rejected");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    expect(toast.error.mock.calls[0][0]).not.toBe("สถานะงานนี้เปลี่ยนไปแล้ว");
    expect(notify).not.toHaveBeenCalled();
  });
});
