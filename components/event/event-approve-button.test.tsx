// The daily "มีงานรออนุมัติ" reminder links to the event; the approve control used
// to exist only on the Overview board. This pins that an approver who lands on a
// waiting show can approve it right there — through the same write + notify path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  updates: [] as unknown[],
  notified: [] as string[],
  refresh: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: (v: unknown) => (h.updates.push(v), b),
        eq: () => b,
        select: () => ({ abortSignal: () => Promise.resolve({ data: [{ id: "e1" }], error: null }) }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: (t: string) => h.notified.push(t) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventApproveButton } from "./event-approve-button";

beforeEach(() => {
  h.updates = [];
  h.notified = [];
  h.refresh.mockClear();
});

describe("EventApproveButton", () => {
  it("lets an approver approve a waiting show from its own page", async () => {
    render(<EventApproveButton eventId="e1" eventName="Sourgrumy" status="pending_review" />);
    fireEvent.click(screen.getByRole("button", { name: /อนุมัติ \/ ปฏิเสธ/ }));
    fireEvent.click(screen.getByRole("button", { name: /^อนุมัติ$/ }));
    await waitFor(() => expect(h.updates).toEqual([{ status: "approved" }]));
    expect(h.notified).toEqual(["event_approved"]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it.each(["draft", "approved", "rejected"] as const)(
    "shows nothing when the show is %s — there is nothing to approve",
    (status) => {
      render(<EventApproveButton eventId="e1" eventName="x" status={status} />);
      expect(screen.queryByRole("button", { name: /อนุมัติ/ })).toBeNull();
    }
  );
});
