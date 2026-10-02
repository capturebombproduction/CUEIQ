// A hanging connection at a venue used to leave the อนุมัติ / ปฏิเสธ dialog stuck: it cannot be
// closed while a write is in flight (closing would hide whether the write landed), and the write
// had no deadline, so the spinner and the un-closable dialog stayed until the app was reloaded.
// The request is now cut after STATUS_WRITE_TIMEOUT_MS; the dialog frees itself and claims neither
// outcome (the cut request may still have landed).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn(), signals: [] as AbortSignal[] }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: () => b,
        eq: () => b,
        // never answers; rejects only when its signal is aborted (as fetch does)
        select: () => ({
          abortSignal: (signal: AbortSignal) => {
            h.signals.push(signal);
            return new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
            );
          },
        }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { EventStatusActions, STATUS_WRITE_TIMEOUT_MS } from "./event-status-actions";

beforeEach(() => {
  vi.useFakeTimers();
  h.toastError.mockClear();
  h.toastSuccess.mockClear();
  h.signals.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("EventStatusActions on a hanging network", () => {
  it("cuts the write after the deadline, frees the dialog and claims no outcome", async () => {
    render(<EventStatusActions eventId="e1" initialStatus="pending_review" trigger="button" />);
    fireEvent.click(screen.getByRole("button", { name: /อนุมัติ/ }));
    const approve = screen.getAllByRole("button", { name: /อนุมัติ/ }).at(-1)!;
    fireEvent.click(approve);
    expect(approve).toBeDisabled(); // in flight: the dialog holds
    expect(h.signals).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(STATUS_WRITE_TIMEOUT_MS - 1);
    });
    expect(h.signals[0].aborted).toBe(false);
    expect(approve).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(h.signals[0].aborted).toBe(true);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastError.mock.calls[0][0]).toContain("ยังไม่รู้ว่าบันทึกแล้วหรือยัง");
    // free again: the buttons work and the dialog can be closed
    expect(approve).not.toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
