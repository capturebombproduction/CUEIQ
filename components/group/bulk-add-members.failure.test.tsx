// "เพิ่มหลายคน" used to throw the pasted roster away when the insert failed.
//
// components/group/bulk-add-members.tsx submit(): `await onAdd(text); setText("");
// setOpen(false);` - it closes and clears on ANY return. GroupManager.bulkAddMembers
// (group-manager.tsx:218-222) reports a failed insert with a toast and RETURNS (never
// throws), so on venue wifi / an RLS refusal / a bad mic number the Ar's typed or
// pasted roster (8 lines of Thai names, nicknames, mic numbers) vanishes with the
// dialog, and nothing was added.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));

import { GroupManager } from "@/components/group/group-manager";

const T = "33333333-3333-4333-8333-333333333333";
const SEISHIN: Group = {
  id: "g-seishin",
  tenant_id: T,
  name: "Seishin Kakumei",
  color: "#A62A1C",
  skin: null,
  exempt_from_deadline: false,
  self_photo: true,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ script: { members: fail("Failed to fetch", 0) } });
  h.supa = supa;
});

const ROSTER = "ยูกิ ทานากะ, ยูกิ, 1\nเชอร์รี่, เชอ, 2\nริโกะ, ริ, 3";

describe("bulk add keeps the roster when the save fails", () => {
  it("a failed insert leaves the dialog open with the pasted lines", async () => {
    render(
      <ConfirmProvider>
        <GroupManager
          tenantId={T}
          initialGroups={[SEISHIN]}
          initialMembers={[]}
          perms={makePerms("member", [{ group_id: SEISHIN.id, role: "artist_manager" }])}
        />
      </ConfirmProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เพิ่มหลายคน/ }));
    });
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: ROSTER } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เพิ่มทั้งหมด/ }));
    });
    // the insert really went out and really failed
    expect(supa.callsTo("members", "insert")).toHaveLength(1);
    // ...and the roster must still be there to retry
    expect(screen.queryByRole("textbox")).not.toBeNull();
    expect((screen.queryByRole("textbox") as HTMLTextAreaElement | null)?.value).toBe(ROSTER);
  });
});
