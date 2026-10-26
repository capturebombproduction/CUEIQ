// 2026-10-27 hunt (events): EventForm's edit sent EVERY field it opened with,
// changed or not (components/event/event-form.tsx payload), and the online update has no
// updated_at check. An edit form opened before another device moved the show start
// 17:00 -> 18:00 puts 17:00 back when the user only fixes the venue. (status alone is
// already sent only when changed - the same staleness, handled for one field.)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard } from "@/lib/dirty-guard";

const h = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/mgmt-write", () => ({
  // the online update: PATCH the row with the payload, exactly as supabase .update() does
  saveEventWrite: vi.fn(async (args: { payload: Record<string, unknown>; eventId: string }) => {
    Object.assign(h.server, args.payload);
    return { ok: true, id: args.eventId, queued: false };
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventForm } from "@/components/event/event-form";

const opened = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-01",
  venue: "Old Hall", event_type: "idol", show_start_time: "17:00:00",
  hard_out_time: "17:20:00", status: "draft", notes: null, map_url: null, costume_theme: null,
  deadline: null, deadline_note: null, updated_at: "2026-10-26T00:00:00Z",
};

afterEach(() => {
  cleanup();
  resetDirtyGuard();
});

describe("EventForm edit — a field this form never touched", () => {
  it("does not put back the show start another device moved after the form opened", async () => {
    render(
      <ConfirmProvider>
        <EventForm mode="edit" tenantId="t1" userId="u1"
          groups={[{ id: "g1", name: "Seishin" } as never]} event={opened as never} />
      </ConfirmProvider>
    );
    // meanwhile, on the phone: show start moved to 18:00 (and saved)
    h.server = { ...opened, show_start_time: "18:00:00", hard_out_time: "18:20:00" };
    // here: only the venue is fixed
    fireEvent.change(screen.getByLabelText("สถานที่"), { target: { value: "New Hall" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    });
    expect(h.server.venue).toBe("New Hall");
    expect(h.server.show_start_time).toBe("18:00:00");
    expect(h.server.hard_out_time).toBe("18:20:00");
  });
});
