// The answer box under a report that already has an answer.
//
// 2026-10-30, hunt 10: the box said "แก้คำตอบ / ตอบเพิ่ม…" (edit / add to the answer) but
// stayed EMPTY, and ตอบ writes the whole reply column - so a follow-up typed there replaced
// the first answer for good; the author only ever saw the second. Going into the box now
// brings the answer already given.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, notify: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

const FIRST = "แก้ให้แล้วครับ อัปเดตแอปแล้วลองใหม่";
const MORE = "ตามมาอีกนิด: ต้องปิดแล้วเปิดแอปใหม่ด้วย";

const report = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  user_id: "33333333-3333-4333-8333-333333333333",
  category: "bug",
  message: "เพลงไม่เล่นตอนกด NEXT",
  status: "open",
  context: {},
  created_at: "2026-08-15T10:00:00Z",
  reply: FIRST,
  replied_at: "2026-08-16T10:00:00Z",
  images: null,
  ...over,
});

let supa: SupabaseFake;
function mount(feedbackScript: unknown) {
  supa = makeSupabaseFake({
    script: { feedback: feedbackScript as never, client_errors: ok([]) },
  });
  h.supa = supa;
  return render(
    <ConfirmProvider>
      <DevInbox />
    </ConfirmProvider>
  );
}
const box = () => screen.getByTestId("feedback-reply-input-f1") as HTMLTextAreaElement;
const send = () => screen.getByRole("button", { name: "ตอบ" });
const sentReply = () =>
  (supa.query.calls.find((c) => c.verb === "update")?.values as { reply?: string } | undefined)
    ?.reply;

beforeEach(() => h.notify.mockClear());
afterEach(() => cleanup());

describe("DevInbox · answering again", () => {
  it("going into the box brings the answer already given, so ตอบเพิ่ม adds to it", async () => {
    mount([ok([report()]), ok([{ id: "f1" }])]);
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    expect(box().value).toBe(FIRST);

    // what the admin does next: types on after the first answer
    fireEvent.change(box(), { target: { value: `${FIRST}\n${MORE}` } });
    fireEvent.click(send());
    await waitFor(() => expect(sentReply()).toBeTruthy());
    expect(sentReply()).toBe(`${FIRST}\n${MORE}`);
    expect(h.notify).toHaveBeenCalledWith("feedback_replied", { feedbackId: "f1" });
  });

  it("will not resend the same answer: ตอบ is off until it changes", async () => {
    mount(ok([report()]));
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    expect(send()).toBeDisabled();
    // whitespace alone is not a change either
    fireEvent.change(box(), { target: { value: `${FIRST}  ` } });
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(supa.query.calls.some((c) => c.verb === "update")).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("an emptied box cannot wipe the answer", async () => {
    mount(ok([report()]));
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "" } });
    expect(box().value).toBe("");
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(supa.query.calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("never overwrites what the admin typed - not on focus, not across a reload", async () => {
    mount([ok([report()]), ok([report()])]);
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: `${FIRST}\n${MORE}` } });
    fireEvent.blur(box());
    fireEvent.focus(box());
    expect(box().value).toBe(`${FIRST}\n${MORE}`);
    fireEvent.click(screen.getByRole("button", { name: "โหลดใหม่" }));
    await waitFor(() => expect(supa.callsTo("feedback", "select")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "โหลดใหม่" })).not.toBeDisabled());
    expect(box().value).toBe(`${FIRST}\n${MORE}`);
  });

  it("after sending, the next visit to the box starts from the new answer", async () => {
    mount([ok([report()]), ok([{ id: "f1" }])]);
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: MORE } }); // a real edit: replace it
    fireEvent.click(send());
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(sentReply()).toBe(MORE);
    await waitFor(() => expect(box().value).toBe(""));
    fireEvent.focus(box());
    expect(box().value).toBe(MORE);
    expect(send()).toBeDisabled();
  });

  it("an unanswered report's box stays empty", async () => {
    mount(ok([report({ reply: null, replied_at: null })]));
    await screen.findByTestId("feedback-reply-input-f1");
    fireEvent.focus(box());
    expect(box().value).toBe("");
    expect(box().getAttribute("placeholder")).toBe("ตอบกลับคนที่แจ้งมา…");
    expect(send()).toBeDisabled();
  });

  it("keeps the 4000-character cap", async () => {
    mount([ok([report({ reply: null, replied_at: null })]), ok([{ id: "f1" }])]);
    await screen.findByTestId("feedback-reply-input-f1");
    expect(box().maxLength).toBe(4000);
    fireEvent.change(box(), { target: { value: "ก".repeat(4100) } });
    fireEvent.click(send());
    await waitFor(() => expect(sentReply()).toBeTruthy());
    expect(sentReply()!.length).toBe(4000);
  });
});
