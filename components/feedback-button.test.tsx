// The แจ้งปัญหา button — the channel that produced the best work of round 13, and
// that nobody could answer through.
//
// Two things the label asked for by name on 2026-08-13 and never got:
//  · "อยากให้สามารถเพิ่มรูปในที่ส่งฟีดแบคได้"
//  · seeing that someone read it — five reports sat unanswered for two months.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  upload: vi.fn<(key: string, f: File | Blob, contentType?: string) => Promise<void>>(
    async () => {}
  ),
  fetchImage: vi.fn<(key: string) => Promise<Blob>>(
    async () => new Blob(["x"], { type: "image/png" })
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, uploadEventAudio: h.upload, fetchImageBlob: h.fetchImage };
});

import { FeedbackButton } from "@/components/feedback-button";

const TENANT = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

let supa: SupabaseFake;

function mountWith(feedbackScript: unknown) {
  supa = makeSupabaseFake({ script: { feedback: feedbackScript as never } });
  h.supa = supa;
  return render(<FeedbackButton userId={ME} tenantId={TENANT} floating />);
}

const png = (name = "shot.png", bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });

beforeEach(() => {
  h.upload.mockClear();
  h.upload.mockImplementation(async () => {});
  h.fetchImage.mockClear();
  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openDialog = () => fireEvent.click(screen.getByTitle(/แจ้งปัญหา|มีคำตอบ/));

describe("attaching a screenshot", () => {
  it("uploads the picked image and stores its KEY on the row, not a URL", async () => {
    mountWith([ok([]), ok(null), ok([])]);
    openDialog();
    fireEvent.change(screen.getByLabelText("รายละเอียด"), {
      target: { value: "กดปุ่มนี้แล้วเสียงไม่เล่น" },
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [png()] } });
    fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));

    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    const key = h.upload.mock.calls[0][0] as string;
    expect(key).toMatch(new RegExp(`^${TENANT}/feedback/${ME}/[a-z0-9]+\\.png$`));

    await waitFor(() => {
      const insert = supa.query.calls.find((c) => c.verb === "insert");
      expect(insert).toBeTruthy();
      expect((insert!.values as { images: string[] }).images).toEqual([key]);
    });
  });

  it("uploads the BYTES before writing the row, so no key is listed for a file that never landed", async () => {
    const order: string[] = [];
    h.upload.mockImplementation(async () => {
      order.push("upload");
    });
    supa = makeSupabaseFake({
      script: {
        feedback: (call) => {
          if (call.verb === "insert") order.push("insert");
          return ok(null);
        },
      },
    });
    h.supa = supa;
    render(<FeedbackButton userId={ME} tenantId={TENANT} floating />);
    openDialog();
    fireEvent.change(screen.getByLabelText("รายละเอียด"), { target: { value: "ทดสอบ" } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [png()] },
    });
    fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    await waitFor(() => expect(order).toEqual(["upload", "insert"]));
  });

  it("still sends the report when the picture fails — the words are the valuable part", async () => {
    h.upload.mockRejectedValue(new Error("R2 down"));
    mountWith([ok([]), ok(null), ok([])]);
    openDialog();
    fireEvent.change(screen.getByLabelText("รายละเอียด"), { target: { value: "ลองดู" } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [png()] },
    });
    fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    await waitFor(() => {
      const insert = supa.query.calls.find((c) => c.verb === "insert");
      expect(insert).toBeTruthy();
      // …and with NO key listed for the picture that never arrived.
      expect((insert!.values as { images: string[] }).images).toEqual([]);
    });
  });

  it("refuses a non-image and an oversized file at the picker", async () => {
    mountWith([ok([])]);
    openDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "notes.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(input, { target: { files: [png("huge.png", 9 * 1024 * 1024)] } });
    expect(document.querySelectorAll('img[alt="huge.png"]').length).toBe(0);
    expect(screen.queryByAltText("notes.pdf")).toBeNull();
  });

  it("caps the number of attachments", async () => {
    mountWith([ok([])]);
    openDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [png("a.png"), png("b.png"), png("c.png"), png("d.png")] },
    });
    expect(document.querySelectorAll('img[alt$=".png"]').length).toBe(3);
    // …and the "แนบรูป" tile is gone once it is full.
    expect(screen.queryByTestId("feedback-add-image")).toBeNull();
  });

  it("does not send at all when the message is too short", async () => {
    mountWith([ok([])]);
    openDialog();
    fireEvent.change(screen.getByLabelText("รายละเอียด"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    await waitFor(() => expect(h.upload).not.toHaveBeenCalled());
    expect(supa.query.calls.some((c) => c.verb === "insert")).toBe(false);
  });
});

describe("hearing back", () => {
  const replied = {
    id: "f1",
    category: "bug",
    message: "งานมี 2 ชุด",
    status: "open",
    created_at: "2026-08-15T10:00:00Z",
    reply: "แก้ให้แล้วครับ — สร้างรอบที่ 2 ได้เลย",
    replied_at: "2026-08-31T09:00:00Z",
    reply_seen_at: null,
    images: null,
  };

  it("puts a dot on the button when an answer is waiting", async () => {
    mountWith(ok([{ id: "f1" }]));
    expect(await screen.findByTestId("feedback-unread-dot")).toBeTruthy();
  });

  it("shows no dot when every answer has been read", async () => {
    mountWith(ok([]));
    openDialog();
    await waitFor(() =>
      expect(screen.queryByTestId("feedback-unread-dot")).toBeNull()
    );
  });

  it("shows the admin's reply in ที่ส่งไปแล้ว and stamps it as seen", async () => {
    // 1st read = the unread probe, 2nd = the list, 3rd = the seen stamp.
    mountWith([ok([{ id: "f1" }]), ok([replied]), ok([{ id: "f1" }])]);
    openDialog();
    fireEvent.click(screen.getByTestId("feedback-tab-mine"));
    expect(await screen.findByTestId("feedback-reply")).toHaveTextContent(
      "แก้ให้แล้วครับ"
    );
    await waitFor(() => {
      const stamp = supa.query.calls.find(
        (c) => c.verb === "update" && "reply_seen_at" in (c.values as object)
      );
      expect(stamp).toBeTruthy();
      // …and it asks for its rows back, so a write that touched nothing is visible
      // (lib/write-guard.ts).
      expect(stamp!.selectAfterWrite).toBe(true);
    });
  });

  it("leaves the dot up when the seen-stamp write fails", async () => {
    mountWith([ok([{ id: "f1" }]), ok([replied]), fail("boom")]);
    openDialog();
    fireEvent.click(screen.getByTestId("feedback-tab-mine"));
    await screen.findByTestId("feedback-reply");
    // The harmless direction: an unread dot that lingers, never a reply marked
    // read that the person never saw.
    expect(screen.getByTestId("feedback-unread-dot")).toBeTruthy();
  });

  it("says so plainly when nothing has been answered yet", async () => {
    mountWith([ok([]), ok([{ ...replied, reply: null, replied_at: null }])]);
    openDialog();
    fireEvent.click(screen.getByTestId("feedback-tab-mine"));
    expect(await screen.findByText("ยังไม่มีคำตอบ")).toBeTruthy();
    expect(screen.queryByTestId("feedback-reply")).toBeNull();
  });
});
