// A member who leaves is marked, not deleted (2026-10-27, พี่: "ทำสถานะ ออกจากวงแล้ว ให้สมาชิก
// แทนการลบ (เก็บชื่อในไลน์อัปเก่าและประวัติเช็คชื่อ)"; migration 0054).
//
// event_members and practice_attendance are ON DELETE CASCADE on members (prod
// pg_constraint), so deleting a member who graduated took them out of the lineup of every
// show they ever played - past run sheets and the share page too - and out of the practice
// attendance history. Hunt 7 first made the delete count and warn; now a member with any
// history (or whose history could not be read) LEAVES instead (members.left_at), back with
// one tap, and a permanent delete lives in the "ออกจากวงแล้ว" list behind their typed name.
// A row with no history at all (added by mistake) is still simply deleted.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { fail, makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
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

function mount(db: SupabaseFake, members: Member[] = [M]) {
  h.db = db;
  render(
    <ConfirmProvider>
      <GroupManager tenantId={T} initialGroups={[G]} initialMembers={members} perms={makePerms("admin", [])} />
    </ConfirmProvider>
  );
}

const roster = () => screen.queryAllByLabelText("ชื่อ");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artists: a member with history leaves the band instead of being deleted", () => {
  it("says what stays, and ออกจากวง marks left_at - nothing is deleted", async () => {
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
    expect(within(dialog).getByText(/ไลน์อัปของ 27 งานที่ผ่านมา/)).toBeTruthy();
    expect(within(dialog).getByText(/เช็คชื่อซ้อม 4 ครั้งยังอยู่/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "ออกจากวง" }));
    await waitFor(() => expect(db.callsTo("members", "update")).toHaveLength(1));
    const write = db.callsTo("members", "update")[0];
    expect(typeof (write.values as { left_at?: unknown }).left_at).toBe("string");
    expect(write.selectAfterWrite).toBe(true);
    expect(db.callsTo("members", "delete")).toHaveLength(0);
    // out of today's roster, into the left list
    await waitFor(() => expect(roster()).toHaveLength(0));
    expect(screen.getByText(/ออกจากวงแล้ว/)).toBeTruthy();
  });

  it("a history read that failed also leaves (reversible), never deletes", async () => {
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
    expect(within(dialog).getByRole("button", { name: "ออกจากวง" })).toBeTruthy();
  });

  it("zero counts read without a session are not believed: it offers ออกจากวง, not delete", async () => {
    // ตาที่ 3 on hunt 7: as anon RLS counts 0 with no error, and that read as "in no show"
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
    expect(within(dialog).getByRole("button", { name: "ออกจากวง" })).toBeTruthy();
  });

  it("a row with no history at all (added by mistake) keeps the plain one-tap delete", async () => {
    const db = makeSupabaseFake({
      session: makeSession(),
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
    expect(within(dialog).queryByRole("button", { name: "ออกจากวง" })).toBeNull();
  });
});

describe("Artists: the ออกจากวงแล้ว list", () => {
  const LEFT: Member = { ...M, left_at: "2026-10-27T03:00:00Z" };

  it("is out of the roster and the head count, with when they left", () => {
    mount(makeSupabaseFake({ script: { members: ok([{ id: "m1" }]) } }), [LEFT]);
    expect(roster()).toHaveLength(0);
    expect(screen.getByText("ยังไม่มีสมาชิก")).toBeTruthy();
    expect(screen.getByText("2026-10-27")).toBeTruthy();
  });

  it("กลับเข้าวง clears left_at and puts them back in the roster", async () => {
    const db = makeSupabaseFake({ script: { members: ok([{ id: "m1" }]) } });
    mount(db, [LEFT]);
    fireEvent.click(screen.getByRole("button", { name: /กลับเข้าวง/ }));
    await waitFor(() => expect(db.callsTo("members", "update")).toHaveLength(1));
    expect(db.callsTo("members", "update")[0].values).toEqual({ left_at: null });
    await waitFor(() => expect(roster()).toHaveLength(1));
  });

  it("ลบถาวร says what goes and needs the name typed", async () => {
    const db = makeSupabaseFake({
      script: {
        event_members: ok([], { count: 3 }),
        practice_attendance: ok([], { count: 0 }),
        members: ok([{ id: "m1" }]),
      },
    });
    mount(db, [LEFT]);
    fireEvent.click(screen.getByRole("button", { name: /ลบถาวร/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ไลน์อัปของ 3 งาน/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("พิมพ์ Yuki เพื่อยืนยัน"), { target: { value: "Yuki" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบถาวร" }));
    await waitFor(() => expect(db.callsTo("members", "delete")).toHaveLength(1));
  });
});
