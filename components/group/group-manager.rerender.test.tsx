// 2026-10-27 hunt 3 (admin), a regression of 17b15ef: GroupManager adopted its
// initialGroups / initialMembers whenever their IDENTITY changed. The desktop Artists page
// handed it a fresh array on every re-render (App re-renders on each auth event: SIGNED_IN
// on every return to the window, the hourly TOKEN_REFRESHED), so the roster went back to
// the first fetch - a member just added vanished, a renamed field reverted, and because
// every field saves on blur, tabbing through wrote the old value over the newer one.
// A page copy that only re-arrives EQUAL carries nothing newer than the screen; a page
// copy with new content (group-manager.refresh.test.tsx) is still adopted.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.db }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";

const T = "33333333-3333-4333-8333-333333333333";
const SEISHIN: Group = {
  id: "g-seishin", tenant_id: T, name: "Seishin Kakumei", color: "#A62A1C", skin: null,
  exempt_from_deadline: false, self_photo: true, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};
const YUKI: Member = {
  id: "m1", tenant_id: T, group_id: SEISHIN.id, name: "Yuki", nickname: null, mic_number: 1,
  color: null, sort_order: 1, created_at: "2026-01-01T00:00:00Z",
};
const NEW: Member = { ...YUKI, id: "m2", name: "", mic_number: null, sort_order: 2 };

afterEach(() => cleanup());

// A parent that rebuilds both arrays on every render, the way the desktop page did.
const ui = () => (
  <ConfirmProvider>
    <GroupManager
      tenantId={T}
      initialGroups={[{ ...SEISHIN }]}
      initialMembers={[{ ...YUKI }]}
      perms={makePerms("admin", [])}
    />
  </ConfirmProvider>
);

describe("GroupManager - a parent re-render with the same roster", () => {
  it("keeps a member just added on screen", async () => {
    h.db = makeSupabaseFake({
      script: { members: (c) => (c.verb === "insert" ? ok(NEW) : ok([{ id: "m1" }])) },
    });
    const r = render(ui());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เพิ่มสมาชิก/ }));
    });
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(2);
    r.rerender(ui()); // new arrays, same content
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(2);
  });

  it("keeps a field being typed in instead of putting the old value back", () => {
    h.db = makeSupabaseFake({ script: { members: ok([{ id: "m1" }]), groups: ok([{ id: SEISHIN.id }]) } });
    const r = render(ui());
    fireEvent.change(screen.getByLabelText("ชื่อ"), { target: { value: "Yuki Tanaka" } });
    fireEvent.change(screen.getByLabelText("ชื่อวง"), { target: { value: "Seishin" } });
    r.rerender(ui());
    expect((screen.getByLabelText("ชื่อ") as HTMLInputElement).value).toBe("Yuki Tanaka");
    expect((screen.getByLabelText("ชื่อวง") as HTMLInputElement).value).toBe("Seishin");
  });
});
