// Deleting a roster member, and what goes with her (2026-10-27, hunt 7).
//
// event_members and practice_attendance are ON DELETE CASCADE on members (prod
// pg_constraint), so deleting a member who graduated took her out of the lineup of every
// show she ever played - past run sheets and the share page too - and out of the practice
// attendance history. The prompt said only "“Yuki” จะถูกลบออกจากวง", one tap, no count.
// It now counts both first, says what goes, and asks for her name typed when anything
// does; a count that failed says it could not check (as the song delete does).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { fail, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artists: deleting a member says what goes with her", () => {
  it("names how many shows' lineups and practice check-ins she leaves, and asks for her name", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: ok([], { count: 27 }),
        practice_attendance: ok([], { count: 4 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ไลน์อัปของ 27 งาน/)).toBeTruthy();
    expect(within(dialog).getByText(/เช็คชื่อซ้อม 4 ครั้ง/)).toBeTruthy();
    expect(within(dialog).getByLabelText("พิมพ์ Yuki เพื่อยืนยัน")).toBeTruthy();
    expect(db.callsTo("members", "delete")).toHaveLength(0);
  });

  it("a count that failed says it could not check, and still asks for her name", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: fail("Failed to fetch", 0),
        practice_attendance: ok([], { count: 0 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ตรวจไม่ได้ว่าอยู่ในไลน์อัปงานไหนบ้าง/)).toBeTruthy();
    expect(within(dialog).getByLabelText("พิมพ์ Yuki เพื่อยืนยัน")).toBeTruthy();
  });

  it("a member in no show and no check-in keeps the plain one-tap prompt", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: ok([], { count: 0 }),
        practice_attendance: ok([], { count: 0 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("“Yuki” จะถูกลบออกจากวง")).toBeTruthy();
    expect(within(dialog).queryByLabelText("พิมพ์ Yuki เพื่อยืนยัน")).toBeNull();
  });
});
