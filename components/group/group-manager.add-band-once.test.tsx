// Adding a band by Enter (2026-10-27, hunt 7): the "ชื่อวงใหม่" box called addGroup() on
// Enter past the button's disabled={busy}, so a second Enter (or a held key repeating)
// while the first insert was still in flight created the same band twice.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";

const insert = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: unknown) => {
        insert(row);
        // never answers: the first add is still in flight when the second Enter lands
        return { select: () => ({ single: () => new Promise(() => {}) }) };
      },
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { GroupManager } from "@/components/group/group-manager";

describe("Artists: a new band is added once", () => {
  it("a second Enter while the first add is in flight inserts nothing more", () => {
    render(
      <ConfirmProvider>
        <GroupManager tenantId="t" initialGroups={[]} initialMembers={[]} perms={makePerms("admin", [])} />
      </ConfirmProvider>
    );
    const box = screen.getByLabelText("ชื่อวงใหม่");
    fireEvent.change(box, { target: { value: "Seishin Kakumei" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", repeat: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
