// Hunt 3 (2026-10-27), admin-1, a regression of 17b15ef: GroupManager adopts a new
// initialGroups / initialMembers as a refreshed page. Artists computed
// `viewableGroups(ws.perms, ws.groups)` inline - a NEW array on every render - and App
// re-renders on each auth event (auth-js emits SIGNED_IN on every return to the window,
// TOKEN_REFRESHED hourly). Each one put the roster back to the first fetch: a member just
// added vanished, a renamed field reverted, and tabbing through the blur-saved fields
// wrote the old name / mic number back over the newer one.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { Group, Member } from "@/lib/types";

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

const h = vi.hoisted(() => ({
  supa: null as unknown,
  ws: null as unknown,
  // every initialGroups GroupManager was handed, render by render
  handed: [] as unknown[],
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/group/group-manager", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/group/group-manager")>();
  return {
    GroupManager: (p: Parameters<typeof real.GroupManager>[0]) => {
      h.handed.push(p.initialGroups);
      return <real.GroupManager {...p} />;
    },
  };
});

import { Artists } from "~/pages/artists";

function setup() {
  h.handed = [];
  h.supa = makeSupabaseFake({
    script: { members: (c) => (c.verb === "insert" ? ok(NEW) : ok([YUKI])) },
  });
  // ONE workspace object for the whole test: an auth event re-renders App, it does not
  // reload the workspace.
  h.ws = {
    membership: { tenant_id: T, role: "admin" },
    tenant: { id: T, name: "A Lot Of Tone" },
    perms: makePerms("admin", []),
    groups: [SEISHIN],
    user: { id: "u1", email: "architect@cueiq.local", name: "a" },
  };
  const ui = () => (
    <MemoryRouter>
      <ConfirmProvider>
        <Artists />
      </ConfirmProvider>
    </MemoryRouter>
  );
  return { ui, r: render(ui()) };
}

describe("desktop Artists: an auth-event re-render keeps the roster on screen", () => {
  it("a member just added is still there after the re-render", async () => {
    const { ui, r } = setup();
    await screen.findAllByLabelText("ชื่อ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เพิ่มสมาชิก/ }));
    });
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(2);
    r.rerender(ui());
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(2);
  });

  it("hands GroupManager the same bands array while the workspace is the same", async () => {
    const { ui, r } = setup();
    await screen.findAllByLabelText("ชื่อ");
    r.rerender(ui());
    r.rerender(ui());
    expect(h.handed.length).toBeGreaterThan(1);
    expect(new Set(h.handed).size).toBe(1);
  });
});
