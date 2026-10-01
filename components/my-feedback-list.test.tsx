// "ที่ส่งไปแล้ว" as a conversation (spec §G.9): what the person wrote on the left,
// the team's answer on the right, the category as an icon + word, and an attached
// screenshot that opens full size instead of staying a 64 px postage stamp.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  fetchImage: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchImageBlob: h.fetchImage };
});

import { MyFeedbackList } from "@/components/my-feedback-list";
import { FeedbackButton, FeedbackUnreadProvider } from "@/components/feedback-button";

const row = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  category: "bug",
  message: "กดเล่นแล้วเสียงไม่ออก",
  status: "open",
  created_at: "2026-09-20T10:00:00Z",
  reply: "แก้ให้แล้วครับ",
  replied_at: "2026-09-21T10:00:00Z",
  reply_seen_at: "2026-09-21T11:00:00Z",
  images: ["t/feedback/u/abcd1234abcd1234.png"],
  ...over,
});

function mount(rows: unknown[]) {
  h.supa = makeSupabaseFake({ script: { feedback: ok(rows) } });
  return render(<MyFeedbackList userId="u1" />);
}

afterEach(() => cleanup());

describe("a sent report reads as a thread", () => {
  it("their words on the left, the team's answer on the right, the category as icon + word", async () => {
    mount([row()]);
    const reply = await screen.findByTestId("feedback-reply");
    expect(reply).toHaveTextContent("แก้ให้แล้วครับ");
    expect(reply.className).toContain("ml-auto");
    const message = screen.getByText("กดเล่นแล้วเสียงไม่ออก");
    expect(message.className).not.toContain("ml-auto");
    const thread = message.closest("article")!;
    const cat = within(thread).getByText("Bug", { selector: ".chip" });
    expect(cat.querySelector("svg")).not.toBeNull();
  });

  it("opens an attached screenshot full size", async () => {
    mount([row()]);
    await screen.findByTestId("feedback-image");
    fireEvent.click(screen.getByRole("button", { name: "ดูรูปขนาดเต็ม" }));
    const sheet = await screen.findByRole("dialog");
    const big = within(sheet).getByRole("img", { name: "รูปที่แนบมากับฟีดแบค" });
    expect(big.getAttribute("src")).toMatch(/^blob:/);
  });
});

// /feedback renders the Feedback tile (the compose entry) and, under it, its OWN
// "Sent" list — a separate MyFeedbackList from the one inside the tile's dialog. A
// report written from the tile has to show up in that page list straight away: the
// person who just reported a bug is looking right at it.
describe("the /feedback page's own list", () => {
  it("re-reads after a report is sent from the tile beside it", async () => {
    const quiet = (id: string, message: string) =>
      row({ id, message, reply: null, replied_at: null, reply_seen_at: null, images: [] });
    let stored = [quiet("old", "รายงานเก่า")];
    h.supa = makeSupabaseFake({
      script: {
        feedback: (call) => {
          if (call.verb === "insert") {
            stored = [quiet("new", (call.values as { message: string }).message), ...stored];
            return ok(null);
          }
          return ok(stored);
        },
      },
    });
    render(
      <FeedbackUnreadProvider userId="u1">
        <FeedbackButton userId="u1" tenantId="t1" />
        <section data-testid="page-list">
          <MyFeedbackList userId="u1" />
        </section>
      </FeedbackUnreadProvider>
    );
    const page = screen.getByTestId("page-list");
    await within(page).findByText("รายงานเก่า");

    fireEvent.click(screen.getByTitle(/แจ้งปัญหา|มีคำตอบ/));
    fireEvent.change(screen.getByLabelText("รายละเอียด"), { target: { value: "ปุ่มเล่นค้างกลางเพลง" } });
    fireEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    await waitFor(() => expect(stored).toHaveLength(2)); // the report landed…

    // …and the page's list says so, without a reload.
    expect(await within(page).findByText("ปุ่มเล่นค้างกลางเพลง")).toBeTruthy();
    expect(within(page).getByText("รายงานเก่า")).toBeTruthy();
  });
});
