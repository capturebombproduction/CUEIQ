// 2026-10-27 hunt (admin): c4388cf made the Dev Inbox stop saying "ไม่มี error
// ที่ถูกบันทึก — ดีงาม" when it cannot know, and made the per-group delete check its
// write. "ล้างทั้งหมด" (clearAll) and "ล้าง noise" (clearNoise) were left as they were:
// the list is emptied first and neither the tenants read nor the delete is looked at.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

const TENANT = "11111111-1111-4111-8111-111111111111";

afterEach(() => cleanup());

describe("ล้างทั้งหมด that did not delete anything", () => {
  it("does not leave the green 'no errors - ดีงาม' on screen", async () => {
    const supa: SupabaseFake = makeSupabaseFake({
      script: {
        feedback: ok([]),
        client_errors: (c) =>
          c.verb === "select"
            ? ok([{ id: "e1", kind: "error", message: "TypeError: x is undefined", stack: null, url: "https://cueiq-mu.vercel.app/events/a/live", app_version: "19ea761", created_at: "2026-10-27T10:00:00Z" }])
            : fail("canceling statement due to statement timeout", 500),
        tenants: ok({ id: TENANT }),
      },
    });
    h.supa = supa;
    render(
      <ConfirmProvider>
        <DevInbox />
      </ConfirmProvider>
    );
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /ปัญหา/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /ปัญหา/ }));
    fireEvent.click(await screen.findByRole("button", { name: /ล้างทั้งหมด/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(supa.callsTo("client_errors", "delete")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/ไม่มี error ที่ถูกบันทึก/)).toBeNull();
  });
});
