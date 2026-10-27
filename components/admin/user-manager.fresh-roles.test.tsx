// "แก้ไขสิทธิ์" opens from the roles the user has NOW (2026-10-27, hunt 8).
//
// The console read its user list once, when it opened, and a save replaces a user's band
// roles wholesale. Two admins: B gave a member a second band while A's console sat open
// since the morning; A then promoted that member in their first band, and the save sent
// A's old list - B's band was taken away under a green "อัปเดตสิทธิ์แล้ว".
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
const ME: ManagedUser = { user_id: "u-me", email: "patz@cueiq.local", full_name: "Patz", tenantRole: "admin", groupRoles: [] };
const MEMBER = (groupRoles: ManagedUser["groupRoles"]): ManagedUser => ({
  user_id: "u-mem",
  email: "mem@cueiq.local",
  full_name: "Seishin Member",
  tenantRole: "member",
  groupRoles,
});
// what A's console loaded this morning
const LOADED = [ME, MEMBER([{ group_id: "g1", role: "member" }])];
// what the user has now: admin B added Other Band since
const NOW = [ME, MEMBER([{ group_id: "g1", role: "member" }, { group_id: "g2", role: "member" }])];

type Patch = { user_id: string; tenantRole: string; groupRoles: { group_id: string; role: string }[] };
const patches: Patch[] = [];
let gets: (() => Promise<Response>)[] = [];
const listOf = (users: ManagedUser[]) => async () => new Response(JSON.stringify({ users }), { status: 200 });

beforeEach(() => {
  patches.length = 0;
  t.success.mockClear();
  t.error.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Patch;
        patches.push(body);
        return new Response(JSON.stringify({ ok: true, user: body }), { status: 200 });
      }
      return (gets.shift() ?? (async () => new Response("{}", { status: 503 })))();
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string) =>
  within(screen.getByText(name).closest<HTMLElement>('li, [class*="bg-card"]')!);
const bandSelect = (i: number) =>
  within(screen.getByRole("dialog")).getAllByTestId("sel")[i + 1] as HTMLSelectElement;

function mount() {
  render(
    <ConfirmProvider>
      <UserManager currentUserId="u-me" groups={[band("g1", "Seishin Kakumei"), band("g2", "Other Band")]} initialUsers={LOADED} />
    </ConfirmProvider>
  );
}

describe("แก้ไขสิทธิ์ reads the user afresh", () => {
  it("keeps a band another admin gave the user after this console loaded", async () => {
    // the console's own mount re-read failed, so the list is this morning's
    gets = [async () => new Response("{}", { status: 503 }), listOf(NOW)];
    mount();
    fireEvent.click(row("Seishin Member").getByRole("button", { name: "แก้ไขสิทธิ์" }));
    await screen.findByRole("dialog");
    fireEvent.change(bandSelect(0), { target: { value: "artist_manager" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /บันทึก/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].groupRoles).toContainEqual({ group_id: "g1", role: "artist_manager" });
    expect(patches[0].groupRoles).toContainEqual({ group_id: "g2", role: "member" });
  });

  it("opens nothing when that read fails", async () => {
    gets = [async () => new Response("{}", { status: 503 }), async () => {
      throw new TypeError("Failed to fetch");
    }];
    mount();
    fireEvent.click(row("Seishin Member").getByRole("button", { name: "แก้ไขสิทธิ์" }));
    await waitFor(() => expect(t.error).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches).toHaveLength(0);
  });
});
