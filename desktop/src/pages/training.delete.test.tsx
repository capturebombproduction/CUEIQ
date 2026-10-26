// Deleting a practice room on the DESKTOP takes it off the list. DeletePracticeRoomButton
// ends in router.refresh(); on the desktop that is the next-navigation shim's
// emitRefresh(), which only reaches pages that subscribed with onRouterRefresh() - and
// pages/training.tsx did not, so the toast said "ลบห้องซ้อมแล้ว" while the room (and,
// if it was the latest, the lit "Continue · ซ้อมต่อ" hero) stayed on screen.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { Group } from "@/lib/types";
import type { WorkspaceData } from "~/data/workspace";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown, deleted: false }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { Training } from "~/pages/training";

const TENANT = "tenant-a";
const G1: Group = {
  id: "g1",
  tenant_id: TENANT,
  name: "Seishin Kakumei",
  color: null,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z",
};
const ROOM = {
  id: "room-1",
  tenant_id: TENANT,
  group_id: "g1",
  name: "ซ้อมแบบดิจิตอล",
  is_practice: true,
  groups: { name: "Seishin Kakumei", color: null },
};

describe("desktop Training - delete a practice room", () => {
  it("the deleted room leaves the list", async () => {
    h.supa = makeSupabaseFake({
      script: {
        // the server's answer follows the delete, as the real table would
        events: (call) => {
          if (call.verb === "delete") {
            h.deleted = true;
            return ok([{ id: ROOM.id }]);
          }
          return ok(h.deleted ? [] : [ROOM]);
        },
        "*": ok([]),
      },
    });
    h.ws = {
      user: { id: "u1", email: "u@cueiq.local", name: "พี่พัชร์" },
      membership: { tenant_id: TENANT, role: "admin" },
      tenant: { id: TENANT, name: "A Lot Of Tone" },
      groups: [G1],
      groupRoles: [],
      perms: makePerms("admin", []),
    } as unknown as WorkspaceData;

    render(
      <MemoryRouter initialEntries={["/practice"]}>
        <ConfirmProvider>
          <Training />
        </ConfirmProvider>
      </MemoryRouter>
    );
    const rooms = await screen.findByRole("region", { name: "Rooms" });
    expect(within(rooms).getByText(ROOM.name)).toBeTruthy();

    // ⋯ -> ลบห้องซ้อม -> type the name -> ลบห้องซ้อม
    fireEvent.click(screen.getByRole("button", { name: `ตัวเลือกห้องซ้อม ${ROOM.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: /ลบห้องซ้อม/ }));
    fireEvent.change(await screen.findByLabelText(`พิมพ์ ${ROOM.name} เพื่อยืนยัน`), {
      target: { value: ROOM.name },
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "ลบห้องซ้อม" }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.deleted).toBe(true); // the row really left the table

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // …so it must not still be offered on the list
    expect(screen.queryByText(ROOM.name)).toBeNull();
  });
});
