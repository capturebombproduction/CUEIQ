// 2026-10-30, hunt 12. Live Mode reads the show's day, start and Hard Out once, when it opens,
// and nothing told it they had moved: a Hard Out cut on a phone left the PA judging the show
// against the old one all night. A save that moves them now says so on the show's channel.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { makeSupabaseFake, makeSession, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard } from "@/lib/dirty-guard";
import { liveTopic } from "@/lib/realtime";

const h = vi.hoisted(() => ({ supa: null as unknown, queued: false }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/mgmt-write", () => ({
  saveEventWrite: vi.fn(async (args: { eventId: string }) => ({ ok: true, id: args.eventId, queued: h.queued })),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventForm } from "@/components/event/event-form";

const opened = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-01",
  venue: "Old Hall", event_type: "idol", show_start_time: "17:00:00",
  hard_out_time: "17:20:00", status: "draft", notes: null, map_url: null, costume_theme: null,
  deadline: null, deadline_note: null, updated_at: "2026-10-26T00:00:00Z",
};

let supa: SupabaseFake;
beforeEach(() => {
  h.queued = false;
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  resetDirtyGuard();
});

async function edit(change: () => void) {
  render(
    <ConfirmProvider>
      <EventForm mode="edit" tenantId="t1" userId="u1" groups={[{ id: "g1", name: "Seishin" } as never]} event={opened as never} />
    </ConfirmProvider>
  );
  change();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
  });
}
const setHardOut = () =>
  fireEvent.change(document.querySelector('input[value="17:20"]') as HTMLInputElement, { target: { value: "17:10" } });

describe("EventForm: the show's times and an open Live Mode", () => {
  it("a Hard Out moved tells the show's channel, which then closes", async () => {
    await edit(setHardOut);
    const ch = supa.channelFor(liveTopic("e1"))!;
    expect(ch).toBeTruthy();
    await act(async () => ch.setStatus("SUBSCRIBED"));
    expect(ch.sent.map((s) => s.event)).toEqual(["setlist-changed"]);
    await act(async () => {});
    expect(ch.removed).toBe(true);
  });

  it("a save that touched no time tells nobody", async () => {
    await edit(() => fireEvent.change(screen.getByLabelText("สถานที่"), { target: { value: "New Hall" } }));
    expect(supa.channelFor(liveTopic("e1"))).toBeFalsy();
  });

  it("a save still in the queue tells nobody: the server does not hold it yet", async () => {
    h.queued = true;
    await edit(setHardOut);
    expect(supa.channelFor(liveTopic("e1"))).toBeFalsy();
  });
});
