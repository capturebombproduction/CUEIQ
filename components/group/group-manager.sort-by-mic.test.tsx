// Artists' "เรียงตามเลขไมค์" (2026-11-10). พี่, 2026-11-08, on Seishin's roster standing in the
// order the members were added: "สลับตำแหน่งให้เรียงถูกต้องที" - the only cure then was a script
// on the database, because nothing in the app writes members.sort_order after the insert.
// The button rewrites one band's order to its mic numbers; each row is written only if it
// still carries the number this screen saw.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.db }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/audio-remote", () => ({ removeEventAudio: vi.fn(async () => {}) }));

import { toast } from "sonner";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";

const T = "33333333-3333-4333-8333-333333333333";
const G: Group = {
  id: "g1", tenant_id: T, name: "Seishin Kakumei", color: "#A62A1C", skin: null,
  exempt_from_deadline: false, self_photo: true, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};
const m = (id: string, name: string, mic: number | null, sort_order: number): Member => ({
  id, tenant_id: T, group_id: "g1", name, nickname: null, mic_number: mic, color: null, sort_order,
  created_at: "2026-01-01T00:00:00Z",
});
// as the band stood on 2026-11-08: in the order they were added, not by mic
const ADDED = [m("yuki", "Yuki", 2, 1), m("cherrie", "Cherrie", 3, 2), m("frenchfry", "FrenchFry", 1, 3)];

function mount(db: SupabaseFake, members: Member[], perms = makePerms("admin", [])) {
  h.db = db;
  render(
    <ConfirmProvider>
      <GroupManager tenantId={T} initialGroups={[G]} initialMembers={members} perms={perms} />
    </ConfirmProvider>
  );
}
const names = () => screen.queryAllByLabelText("ชื่อ").map((el) => (el as HTMLInputElement).value);
const sortButton = () => screen.queryByRole("button", { name: /เรียงตามเลขไมค์/ }) as HTMLButtonElement | null;
async function pressAndConfirm() {
  fireEvent.click(sortButton()!);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "เรียงเลย" }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artists: เรียงตามเลขไมค์", () => {
  it("asks first, then writes the new order row by row and shows the band in mic order", async () => {
    const db = makeSupabaseFake({ script: { members: (call) => ok([{ id: call.eq.id }]) } });
    mount(db, ADDED);
    expect(names()).toEqual(["Yuki", "Cherrie", "FrenchFry"]);
    fireEvent.click(sortButton()!);
    const dialog = await screen.findByRole("dialog");
    // nothing is written until the answer
    expect(db.callsTo("members", "update")).toHaveLength(0);
    expect(within(dialog).getByText(/เลขไมค์ของแต่ละคนไม่เปลี่ยน/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "เรียงเลย" }));
    await waitFor(() => expect(names()).toEqual(["FrenchFry", "Yuki", "Cherrie"]));
    const writes = db.callsTo("members", "update");
    // every row, guarded by the number it carried (a compare-and-swap), and read back
    expect(writes.map((w) => [w.eq.id, w.eq.sort_order, (w.values as { sort_order: number }).sort_order])).toEqual([
      ["frenchfry", 3, 1],
      ["yuki", 1, 2],
      ["cherrie", 2, 3],
    ]);
    expect(writes.every((w) => w.selectAfterWrite)).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("เรียงตามเลขไมค์แล้ว");
    // in order now: the button has nothing left to do
    expect(sortButton()!.disabled).toBe(true);
  });

  it("a band already in mic order: the button is there and says so, and writes nothing", () => {
    const db = makeSupabaseFake({ script: { members: ok([]) } });
    mount(db, [m("a", "A", 1, 1), m("b", "B", 2, 2), m("c", "C", null, 3)]);
    expect(sortButton()!.disabled).toBe(true);
    expect(sortButton()!.title).toBe("เรียงตามเลขไมค์อยู่แล้ว");
    fireEvent.click(sortButton()!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(db.callsTo("members", "update")).toHaveLength(0);
  });

  it("cancel writes nothing and leaves the order as it was", async () => {
    const db = makeSupabaseFake({ script: { members: ok([]) } });
    mount(db, ADDED);
    fireEvent.click(sortButton()!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.callsTo("members", "update")).toHaveLength(0);
    expect(names()).toEqual(["Yuki", "Cherrie", "FrenchFry"]);
  });

  it("a row that did not take (someone else moved it meanwhile) is said, and only the written rows move", async () => {
    // Yuki's row no longer carries the number this screen saw: her write matches no row
    const db = makeSupabaseFake({
      script: {
        members: (call) => (call.verb === "update" ? ok(call.eq.id === "yuki" ? [] : [{ id: call.eq.id }]) : ok([])),
      },
    });
    mount(db, ADDED);
    await pressAndConfirm();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("เรียงได้ไม่ครบ — กดเรียงอีกครั้ง");
    expect(toast.success).not.toHaveBeenCalled();
    // FrenchFry → 1 and Cherrie → 3 were written; Yuki still carries 1 (as the database does)
    await waitFor(() => expect(names().at(-1)).toBe("Cherrie"));
    expect(sortButton()!.disabled).toBe(false);
  });

  it("someone who may only look at the band has no such button", () => {
    const db = makeSupabaseFake({ script: {} });
    mount(db, ADDED, makePerms("member", [{ group_id: "g1", role: "member" }]));
    expect(sortButton()).toBeNull();
  });

  it("one member, or none: nothing to put in order, no button", () => {
    const db = makeSupabaseFake({ script: {} });
    mount(db, [m("yuki", "Yuki", 2, 1)]);
    expect(sortButton()).toBeNull();
  });
});
