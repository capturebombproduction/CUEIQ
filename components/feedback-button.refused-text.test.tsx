// What the report form says when the server refuses the report.
//
// 2026-10-30, hunt 10: a report sent as anon (a laptop just woken, its token refresh not
// through yet) fails feedback_insert's `user_id = auth.uid()` check, and the toast showed
// PostgREST's English: 'new row violates row-level security policy for table "feedback"'.
// It now says it in Thai (lib/write-guard.ts writeErrorText); the offline toast is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, fail } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: h.toast }));

import { FeedbackButton, FeedbackUnreadProvider } from "@/components/feedback-button";

const TENANT = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const TYPED = "กดปุ่มนี้แล้วเสียงไม่เล่น";

function sendWith(insert: ReturnType<typeof ok>) {
  // the provider's unread read first, then the insert
  h.supa = makeSupabaseFake({ script: { feedback: [ok([]), insert] as never } });
  render(
    <FeedbackUnreadProvider userId={ME}>
      <FeedbackButton userId={ME} tenantId={TENANT} />
    </FeedbackUnreadProvider>
  );
  fireEvent.click(screen.getByTitle(/แจ้งปัญหา|มีคำตอบ/));
  fireEvent.change(screen.getByLabelText("รายละเอียด"), { target: { value: TYPED } });
  fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));
}

beforeEach(() => Object.values(h.toast).forEach((f) => f.mockClear()));
afterEach(() => cleanup());

describe("FeedbackButton · a refused report", () => {
  it("says an RLS refusal in Thai, never PostgREST's English", async () => {
    sendWith(
      fail(
        { code: "42501", message: 'new row violates row-level security policy for table "feedback"' },
        403
      )
    );
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    const [title, opts] = h.toast.error.mock.calls[0] as [string, { description?: string }];
    expect(title).toBe("ส่งไม่สำเร็จ");
    expect(opts?.description).not.toMatch(/row-level security/i);
    expect(opts?.description).toMatch(/เซสชันหมดอายุ/);
    // nothing is lost: the text is still in the box
    expect((screen.getByLabelText("รายละเอียด") as HTMLTextAreaElement).value).toBe(TYPED);
  });

  it("still says 'offline' for a network failure", async () => {
    sendWith(fail({ code: "", message: "TypeError: Failed to fetch" }, 0));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0][0]).toBe("ออฟไลน์อยู่ — ส่งไม่สำเร็จ");
  });

  it("passes any other refusal through as it was", async () => {
    sendWith(fail({ code: "23514", message: "new row violates check constraint" }, 400));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    const [title, opts] = h.toast.error.mock.calls[0] as [string, { description?: string }];
    expect(title).toBe("ส่งไม่สำเร็จ");
    expect(opts?.description).toBe("new row violates check constraint");
  });
});
