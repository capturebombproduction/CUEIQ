// The Dev Inbox — where five real reports sat unanswered from 27 June to 31 August
// because there was no way to answer them and no way to tell who had written one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, anonEmpty, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  notify: vi.fn(),
  fetchImage: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchImageBlob: h.fetchImage };
});

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

const AUTHOR = "33333333-3333-4333-8333-333333333333";

const report = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  user_id: AUTHOR,
  category: "bug",
  message: "งานมี 2 ชุด ถ่ายทั้ง 2 ชุด แต่สร้าง photo session ได้แค่ 1 อัน",
  status: "open",
  context: { path: "/events/abc#schedule", commit: "deadbee" },
  created_at: "2026-08-15T10:00:00Z",
  reply: null,
  replied_at: null,
  images: null,
  ...over,
});

let supa: SupabaseFake;

function mount(feedbackScript: unknown, names: Record<string, string> = {}) {
  supa = makeSupabaseFake({
    script: { feedback: feedbackScript as never, client_errors: ok([]) },
  });
  h.supa = supa;
  return render(
    <ConfirmProvider>
      <DevInbox namesById={names} />
    </ConfirmProvider>
  );
}

beforeEach(() => {
  h.notify.mockClear();
  h.fetchImage.mockClear();
});
afterEach(() => cleanup());

describe("knowing who wrote it", () => {
  it("shows the submitter's name when the server resolved one", async () => {
    mount(ok([report()]), { [AUTHOR]: "ทิพย์ (Seishin)" });
    expect(await screen.findByText("ทิพย์ (Seishin)")).toBeTruthy();
  });

  it("still renders the report when the name is unknown", async () => {
    // profiles RLS is own-row-only, so the name arrives as a server prop or not at
    // all — its absence must never hide the report itself.
    mount(ok([report()]));
    expect(await screen.findByText(/งานมี 2 ชุด/)).toBeTruthy();
  });
});

describe("answering", () => {
  it("writes the reply, asks for its row back, and tells the author", async () => {
    mount([ok([report()]), ok([{ id: "f1" }])]);
    await screen.findByText(/งานมี 2 ชุด/);
    fireEvent.change(screen.getByTestId("feedback-reply-input-f1"), {
      target: { value: "แก้ให้แล้วครับ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ตอบ" }));

    await waitFor(() => {
      const w = supa.query.calls.find((c) => c.verb === "update");
      expect(w).toBeTruthy();
      const v = w!.values as Record<string, unknown>;
      expect(v.reply).toBe("แก้ให้แล้วครับ");
      expect(v.replied_at).toBeTruthy();
      // A NEW answer is unread again, even if they had read the previous one.
      expect(v.reply_seen_at).toBeNull();
      expect(w!.selectAfterWrite).toBe(true);
      expect(w!.eq.id).toBe("f1");
    });
    expect(h.notify).toHaveBeenCalledWith("feedback_replied", { feedbackId: "f1" });
  });

  it("does NOT claim it answered when the write touched no row", async () => {
    // supabase-js falls back to the anon key after a failed refresh and PostgREST
    // answers the filtered UPDATE with 204 + error:null. See lib/write-guard.ts.
    mount([ok([report()]), anonEmpty()]);
    await screen.findByText(/งานมี 2 ชุด/);
    fireEvent.change(screen.getByTestId("feedback-reply-input-f1"), {
      target: { value: "แก้ให้แล้วครับ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ตอบ" }));
    await waitFor(() => expect(screen.queryByTestId("feedback-reply")).toBeNull());
    // …and above all it must not tell the author an answer is waiting when none is.
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not notify when the write errored outright", async () => {
    mount([ok([report()]), fail("network")]);
    await screen.findByText(/งานมี 2 ชุด/);
    fireEvent.change(screen.getByTestId("feedback-reply-input-f1"), {
      target: { value: "ครับ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ตอบ" }));
    await waitFor(() => expect(h.notify).not.toHaveBeenCalled());
  });

  it("will not send an empty answer", async () => {
    mount(ok([report()]));
    await screen.findByText(/งานมี 2 ชุด/);
    const btn = screen.getByRole("button", { name: "ตอบ" });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId("feedback-reply-input-f1"), {
      target: { value: "   " },
    });
    expect(btn).toBeDisabled();
  });

  it("shows an answer that has already been given", async () => {
    mount(ok([report({ reply: "แก้ไปแล้วใน 0042", replied_at: "2026-08-31T00:00:00Z" })]));
    expect(await screen.findByText("แก้ไปแล้วใน 0042")).toBeTruthy();
  });
});

describe("triage", () => {
  it("puts the status back when marking it done did not land", async () => {
    mount([ok([report()]), anonEmpty()]);
    await screen.findByText(/งานมี 2 ชุด/);
    fireEvent.click(screen.getByTitle("ทำเครื่องหมายว่าจัดการแล้ว"));
    // The optimistic flip has to be undone: this button's entire job is to say
    // "this one is handled", so it must not say it when nothing was written.
    await waitFor(() =>
      expect(screen.getByTitle("ทำเครื่องหมายว่าจัดการแล้ว")).toBeTruthy()
    );
  });
});

describe("attachments", () => {
  it("renders each attached screenshot", async () => {
    mount(ok([report({ images: ["t/feedback/u/abcd1234abcd1234.png"] })]));
    expect(await screen.findByTestId("feedback-image")).toBeTruthy();
    expect(h.fetchImage).toHaveBeenCalledWith("t/feedback/u/abcd1234abcd1234.png");
  });

  it("shows a placeholder — not a broken image — when the object is gone", async () => {
    h.fetchImage.mockRejectedValueOnce(new Error("404"));
    mount(ok([report({ images: ["t/feedback/u/abcd1234abcd1234.png"] })]));
    expect(await screen.findByTestId("feedback-image-missing")).toBeTruthy();
  });
});
