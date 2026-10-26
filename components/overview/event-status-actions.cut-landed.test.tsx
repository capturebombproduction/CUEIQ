// 2026-10-27 hunt (overview-1): the band hears a verdict ONCE. A retry that finds the row
// already approved tells the band only when it was THIS screen's own try - the one the
// timeout cut off - that landed unannounced. Another approver who got there first already
// told them (see event-status-actions.moved-on.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  notify: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  updates: 0,
  server: "approved",
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: () => {
          h.updates += 1;
          return b;
        },
        eq: () => b,
        select: () => sel,
      };
      const sel = {
        eq: () => sel,
        abortSignal: (signal: AbortSignal) =>
            h.updates === 1
              ? // the first try never answers (it lands on the server all the same)
                new Promise((_, reject) =>
                  signal.addEventListener("abort", () =>
                    reject(new DOMException("The operation was aborted.", "AbortError"))
                  )
                )
              : // the retry finds nothing left to change
                Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: { status: h.server }, error: null }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { EventStatusActions, STATUS_WRITE_TIMEOUT_MS } from "./event-status-actions";

beforeEach(() => {
  vi.useFakeTimers();
  h.notify.mockReset();
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
  h.updates = 0;
});
afterEach(() => vi.useRealTimers());

async function press(label: RegExp) {
  const btn = screen.getAllByRole("button", { name: label }).at(-1)!;
  await act(async () => {
    fireEvent.click(btn);
  });
}

describe("EventStatusActions — a cut-off approve that landed", () => {
  it("the retry tells the band, once", async () => {
    h.server = "approved";
    render(<EventStatusActions eventId="e1" initialStatus="pending_review" trigger="button" />);
    fireEvent.click(screen.getByRole("button", { name: /อนุมัติ/ }));
    await press(/^อนุมัติ$/);
    await act(async () => {
      vi.advanceTimersByTime(STATUS_WRITE_TIMEOUT_MS);
    });
    expect(h.toastError.mock.calls[0]?.[0]).toContain("ยังไม่รู้ว่าบันทึกแล้วหรือยัง");
    expect(h.notify).not.toHaveBeenCalled();

    await press(/^อนุมัติ$/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.updates).toBe(2);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("event_approved", { eventId: "e1" });
  });

  it("then ปฏิเสธ pressed over it: the band still hears of the approval that landed", async () => {
    h.server = "approved";
    render(<EventStatusActions eventId="e1" initialStatus="pending_review" trigger="button" />);
    fireEvent.click(screen.getByRole("button", { name: /อนุมัติ/ }));
    await press(/^อนุมัติ$/);
    await act(async () => {
      vi.advanceTimersByTime(STATUS_WRITE_TIMEOUT_MS);
    });
    await press(/^ปฏิเสธ$/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.toastError.mock.calls.at(-1)?.[0]).toBe("สถานะงานนี้เปลี่ยนไปแล้ว");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("event_approved", { eventId: "e1" });
  });
});
