// Leaving keeps a member on every lineup that already holds them - upcoming shows too, on
// purpose (a band may keep a leaver for a farewell show). 2026-10-27, hunt 8: the ออกจากวง
// dialog counted every one of those lineups as "งานที่ผ่านมา" and promised the member would
// not show on new shows, so next Saturday's show still had them on its lineup, run sheet and
// share page with nobody told. It now splits past from upcoming (after today in Bangkok, or
// not dated yet) and names the upcoming shows; nothing is taken off automatically.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.db }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/audio-remote", () => ({ removeEventAudio: vi.fn(async () => {}) }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";

const T = "33333333-3333-4333-8333-333333333333";
const G: Group = {
  id: "g1", tenant_id: T, name: "Seishin Kakumei", color: "#A62A1C", skin: null,
  exempt_from_deadline: false, self_photo: true, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};
const M: Member = {
  id: "m1", tenant_id: T, group_id: "g1", name: "Yuki", nickname: null, mic_number: 1,
  color: null, sort_order: 1, created_at: "2026-01-01T00:00:00Z",
};

function mount(db: SupabaseFake) {
  h.db = db;
  render(
    <ConfirmProvider>
      <GroupManager tenantId={T} initialGroups={[G]} initialMembers={[M]} perms={makePerms("admin", [])} />
    </ConfirmProvider>
  );
}

const show = (name: string, event_date: string | null) => ({ event_id: name, events: { name, event_date } });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artists: ออกจากวง tells past lineups from upcoming ones", () => {
  it("counts the past ones as past and names the upcoming ones (undated = upcoming)", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: ok(
          [
            show("Japan Expo", "2026-01-10"),
            show("Farewell", "2099-01-01"),
            show("ยังไม่ลงวัน", null),
            show("Sourgrumy", "2026-03-01"),
          ],
          { count: 4 }
        ),
        practice_attendance: ok([], { count: 0 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ไลน์อัปของ 2 งานที่ผ่านมา/)).toBeTruthy();
    expect(within(dialog).getByText(/ยังอยู่ในไลน์อัปของ 2 งานที่จะถึง \(Farewell, ยังไม่ลงวัน\)/)).toBeTruthy();
    expect(within(dialog).getByText(/เอาออกที่แท็บไลน์อัปของงานนั้น/)).toBeTruthy();
    // the upcoming lineups are left as they are: only left_at is written
    fireEvent.click(within(dialog).getByRole("button", { name: "ออกจากวง" }));
    await waitFor(() => expect(db.callsTo("members", "update")).toHaveLength(1));
    expect(db.callsTo("event_members", "delete")).toHaveLength(0);
  });

  it("names three upcoming shows and counts the rest", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: ok(
          [show("A", "2099-01-04"), show("B", "2099-01-01"), show("C", "2099-01-02"), show("D", "2099-01-03"), show("E", "2099-01-05")],
          { count: 5 }
        ),
        practice_attendance: ok([], { count: 0 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ไลน์อัปของ 5 งานที่จะถึง \(B, C, D และอีก 2 งาน\)/)).toBeTruthy();
    expect(within(dialog).queryByText(/งานที่ผ่านมา/)).toBeNull();
  });
});
