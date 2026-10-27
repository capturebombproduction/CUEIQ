// The console after its own save (2026-10-27, hunt 6).
//
// It learned of a save only through refresh(), its follow-up GET. When that re-read
// failed (503 readFailed, a dead network) the list silently kept the user's OLD band
// roles: the next "แก้ไขสิทธิ์" on that user opened from them, and its save sent the old
// set back - undoing the first save without a word. And a re-read that threw landed a
// red "Failed to fetch" toast right after the green "อัปเดตสิทธิ์แล้ว".
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";

// Radix Select is not drivable in jsdom: a native <select> with the same contract.
vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{ value?: string; onValueChange?: (v: string) => void }>({});
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>;
  const SelectContent = ({ children }: { children: React.ReactNode }) => {
    const c = React.useContext(Ctx);
    return (
      <select data-testid="sel" value={c.value} onChange={(e) => c.onValueChange?.(e.target.value)}>
        {children}
      </select>
    );
  };
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );
  return { Select, SelectContent, SelectItem, SelectTrigger: () => null, SelectValue: () => null };
});
const t = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: t }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { UserManager, type ManagedUser } from "@/components/admin/user-manager";
import type { Group } from "@/lib/types";

const band = (id: string, name: string): Group => ({
  id,
  tenant_id: "t1",
  name,
  color: null,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
});
const G1 = band("g1", "Seishin Kakumei");
const G2 = band("g2", "Other Band");
const USERS: ManagedUser[] = [
  { user_id: "u-me", email: "patz@cueiq.local", full_name: "Patz", tenantRole: "admin", groupRoles: [] },
  {
    user_id: "u-mem",
    email: "mem@cueiq.local",
    full_name: "Seishin Member",
    tenantRole: "member",
    groupRoles: [{ group_id: "g1", role: "member" }],
  },
];

type Patch = { user_id: string; tenantRole: string; groupRoles: { group_id: string; role: string }[] };
const patches: Patch[] = [];
let reread: () => Promise<Response> = async () => new Response("{}", { status: 503 });
// GETs answered in order before `reread` takes over: "แก้ไขสิทธิ์" reads the user
// afresh before its dialog opens (2026-10-27, hunt 8).
let gets: (() => Promise<Response>)[] = [];
const listOf = (users: ManagedUser[]) => async () =>
  new Response(JSON.stringify({ users }), { status: 200 });

beforeEach(() => {
  patches.length = 0;
  gets = [];
  t.success.mockClear();
  t.error.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Patch;
        patches.push(body);
        // the route answers with what it stored (app/api/admin/users PATCH)
        return new Response(
          JSON.stringify({
            ok: true,
            user: { user_id: body.user_id, tenantRole: body.tenantRole, groupRoles: body.groupRoles },
          }),
          { status: 200 }
        );
      }
      return (gets.shift() ?? reread)();
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string) =>
  within(screen.getByText(name).closest<HTMLElement>('li, [class*="bg-card"]')!);
/** The Nth band's role select in the dialog (the first select is the access level). */
const bandSelect = (i: number) =>
  within(screen.getByRole("dialog")).getAllByTestId("sel")[i + 1] as HTMLSelectElement;
const save = () =>
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /บันทึก/ }));

function mount() {
  render(
    <ConfirmProvider>
      <UserManager currentUserId="u-me" groups={[G1, G2]} initialUsers={USERS} />
    </ConfirmProvider>
  );
}

describe("the user console keeps what it saved", () => {
  // Since hunt 8 the edit reads the user afresh and opens nothing when that read fails,
  // so a failed re-read can no longer hand the old roles to the next save at all.
  it("a save whose re-read fails: the next edit opens nothing rather than send the old roles back", async () => {
    reread = async () =>
      new Response(JSON.stringify({ error: "อ่านข้อมูลผู้ใช้ไม่สำเร็จ ลองใหม่อีกครั้ง" }), { status: 503 });
    // the mount's re-read fails; the first edit's own read succeeds
    gets = [reread, listOf(USERS)];
    mount();

    fireEvent.click(row("Seishin Member").getByRole("button", { name: "แก้ไขสิทธิ์" }));
    await screen.findByRole("dialog");
    fireEvent.change(bandSelect(1), { target: { value: "artist_manager" } });
    save();
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(row("Seishin Member").getByRole("button", { name: "แก้ไขสิทธิ์" }));
    await waitFor(() => expect(t.error).toHaveBeenCalledWith("อ่านสิทธิ์ล่าสุดของผู้ใช้นี้ไม่สำเร็จ", expect.anything()));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches).toHaveLength(1);
  });

  it("a re-read that throws after a good save is not a red toast", async () => {
    reread = async () => {
      throw new TypeError("Failed to fetch");
    };
    gets = [reread, listOf(USERS)];
    mount();

    fireEvent.click(row("Seishin Member").getByRole("button", { name: "แก้ไขสิทธิ์" }));
    await screen.findByRole("dialog");
    fireEvent.change(bandSelect(1), { target: { value: "member" } });
    save();
    await waitFor(() => expect(t.success).toHaveBeenCalledWith("อัปเดตสิทธิ์แล้ว"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(t.error).not.toHaveBeenCalled();
  });
});
