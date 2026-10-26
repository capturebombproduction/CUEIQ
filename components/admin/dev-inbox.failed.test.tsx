// The Dev Inbox used to read `feedback` and `client_errors` and never look at
// `.error`. A failed read (statement timeout, an expired session refresh) renders the
// two EMPTY STATES - "ยังไม่มีฟีดแบค" and "ไม่มี error ที่ถูกบันทึก — ดีงาม" - i.e. it
// tells the admin, in green, that nothing is wrong at the moment it cannot know.
// And deleting a note never checks the delete: a refused / failed delete still makes
// the note vanish from the list AND still deletes its screenshots from R2, so the row
// (which comes back on reload) is left pointing at pictures that are gone.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  notify: vi.fn(),
  fetchImage: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
  remove: vi.fn(async (key: string) => void key),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchImageBlob: h.fetchImage, removeEventAudio: h.remove };
});

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTHOR = "33333333-3333-4333-8333-333333333333";
const own = `${TENANT}/feedback/${AUTHOR}/abcd1234abcd1234.png`;

const report = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  user_id: AUTHOR,
  category: "bug",
  message: "เพลงไม่เล่นตอนกด NEXT",
  status: "open",
  context: { path: "/events/abc/live" },
  created_at: "2026-10-20T10:00:00Z",
  reply: null,
  replied_at: null,
  images: [own],
  ...over,
});

let supa: SupabaseFake;

beforeEach(() => {
  h.remove.mockClear();
});
afterEach(() => cleanup());

describe("a failed read is not an empty inbox", () => {
  it("does not say 'no errors - ดีงาม' / 'no feedback' when both reads failed", async () => {
    supa = makeSupabaseFake({
      script: {
        feedback: fail("canceling statement due to statement timeout", 500),
        client_errors: fail("canceling statement due to statement timeout", 500),
      },
    });
    h.supa = supa;
    render(
      <ConfirmProvider>
        <DevInbox />
      </ConfirmProvider>
    );
    await waitFor(() => expect(supa.callsTo("client_errors", "select").length).toBeGreaterThan(0));
    // give the effect a tick to render whatever it renders after the reads settle
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("ยังไม่มีฟีดแบค")).toBeNull();
  });
});

describe("deleting a note whose delete did not land", () => {
  it("keeps the screenshots (and the note) when the row delete fails", async () => {
    supa = makeSupabaseFake({
      script: {
        feedback: [ok([report()]), fail("canceling statement due to statement timeout", 500)],
        client_errors: ok([]),
      },
    });
    h.supa = supa;
    render(
      <ConfirmProvider>
        <DevInbox />
      </ConfirmProvider>
    );
    await screen.findByText(/เพลงไม่เล่น/);
    fireEvent.click(screen.getByRole("button", { name: "ลบ" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(supa.callsTo("feedback", "delete")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.remove).not.toHaveBeenCalled();
  });
});
