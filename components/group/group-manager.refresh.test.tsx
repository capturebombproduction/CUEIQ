// 2026-10-27 hunt (overview): /groups "บันทึก / อัปเดต" (ConfirmSavedBar → router.refresh) promises
// "โหลดข้อมูลล่าสุด", but GroupManager seeds useState from its props once and never
// adopts the refreshed server props: a member another Ar added never appears.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";
import { makePerms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const T = "33333333-3333-4333-8333-333333333333";
const SEISHIN: Group = {
  id: "g-seishin", tenant_id: T, name: "Seishin Kakumei", color: "#A62A1C", skin: null,
  exempt_from_deadline: false, self_photo: true, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};
const m = (id: string, name: string, sort_order: number): Member => ({
  id, tenant_id: T, group_id: SEISHIN.id, name, nickname: null, mic_number: null, color: null,
  sort_order, created_at: "2026-01-01T00:00:00Z",
});

describe("GroupManager — the page refresh", () => {
  it("shows a member that arrived with the refreshed server props", () => {
    const perms = makePerms("member", [{ group_id: SEISHIN.id, role: "member" }]);
    const ui = (members: Member[]) => (
      <ConfirmProvider>
        <GroupManager tenantId={T} initialGroups={[SEISHIN]} initialMembers={members} perms={perms} />
      </ConfirmProvider>
    );
    const { rerender } = render(ui([m("m1", "Yuki", 1)]));
    expect(screen.getAllByText(/Yuki/).length).toBeGreaterThan(0);
    // router.refresh(): same component instance, new server props
    rerender(ui([m("m1", "Yuki", 1), m("m2", "Cherry", 2)]));
    expect(screen.queryAllByText(/Cherry/).length).toBeGreaterThan(0);
  });
});
