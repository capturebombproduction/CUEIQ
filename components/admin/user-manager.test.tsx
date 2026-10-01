// Admin → Users (spec §G.8): one slab per account — name, username, role chip, band
// chips — with its actions as named 44 px buttons. The master-admin protection is
// unchanged: nobody else gets edit, reset or delete on that row, and no one can
// delete themselves.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { UserManager, type ManagedUser } from "@/components/admin/user-manager";
import type { Group } from "@/lib/types";

const SEISHIN: Group = {
  id: "g1",
  tenant_id: "t1",
  name: "Seishin Kakumei",
  color: "#A62A1C",
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};

const USERS: ManagedUser[] = [
  { user_id: "u-master", email: "architect@cueiq.local", full_name: "Architect", tenantRole: "admin", groupRoles: [] },
  { user_id: "u-me", email: "patz@cueiq.local", full_name: "Patz", tenantRole: "admin", groupRoles: [] },
  {
    user_id: "u-mem",
    email: "seishin-mem@cueiq.local",
    full_name: "Seishin Member",
    tenantRole: "member",
    groupRoles: [{ group_id: "g1", role: "member" }],
  },
];

beforeEach(() => {
  // The list re-reads itself once from the API on mount; a failed refresh keeps
  // the server-rendered rows, which is all this file needs.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The account's own row (its slab), wherever the name sits inside it. */
function rowOf(name: string) {
  return screen.getByText(name).closest<HTMLElement>('li, [class*="bg-card"]')!;
}

describe("the users list", () => {
  it("names every action, and keeps the master and self protections", () => {
    render(
      <ConfirmProvider>
        <UserManager currentUserId="u-me" groups={[SEISHIN]} initialUsers={USERS} />
      </ConfirmProvider>
    );
    const member = within(rowOf("Seishin Member"));
    expect(member.getByRole("button", { name: "แก้ไขสิทธิ์" })).toBeTruthy();
    expect(member.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" })).toBeTruthy();
    expect(member.getByRole("button", { name: "ลบบัญชี" })).toBeTruthy();
    expect(member.getByText("seishin-mem").className).toContain("num");
    expect(member.getByText(/Seishin Kakumei · สมาชิก/)).toBeTruthy();

    const master = within(rowOf("Architect"));
    expect(master.getByText("Master")).toBeTruthy();
    expect(master.queryByRole("button")).toBeNull();

    const me = within(rowOf("Patz"));
    expect(me.getByRole("button", { name: "แก้ไขสิทธิ์" })).toBeTruthy();
    expect(me.queryByRole("button", { name: "ลบบัญชี" })).toBeNull();
  });
});
