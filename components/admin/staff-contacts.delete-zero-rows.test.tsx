// 2026-10-27 hunt (admin): removing a crew contact. Every other write on this
// page asks for its rows back (lib/write-guard.ts: "a write that reported no error but
// touched no row did not happen"); the delete does not, so a delete sent as anon after
// a failed token refresh (RLS: zero rows, no error) is shown as done - and the contact
// is back on the next load and on the printed run sheet's contact block.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.db }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { StaffContactsManager } from "@/components/admin/staff-contacts";

const T = "33333333-3333-4333-8333-333333333333";

afterEach(() => cleanup());

describe("crew: delete that touched no row", () => {
  it("is not shown as deleted", async () => {
    const db: SupabaseFake = makeSupabaseFake({ script: { staff_contacts: ok([]) } });
    h.db = db;
    render(
      <ConfirmProvider>
        <StaffContactsManager
          tenantId={T}
          initial={[{ id: "c1", tenant_id: T, name: "พี่ช่างภาพ", role: "ช่างภาพ", phone: "0812345678", sort_order: 1, created_at: "2026-01-01T00:00:00Z" }]}
        />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /แก้ไข พี่ช่างภาพ/ }));
    fireEvent.click(screen.getByRole("button", { name: "ลบทีมงาน" }));
    fireEvent.click(await screen.findByRole("button", { name: /^ลบ$/ }));
    await waitFor(() => expect(db.callsTo("staff_contacts", "delete")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    // the row reached no one: it must still be listed (or the delete must ask for its rows)
    expect(db.callsTo("staff_contacts", "delete")[0].selectAfterWrite).toBe(true);
  });
});
