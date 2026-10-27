// "อ่านทั้งหมด" marks read only what the bell is SHOWING.
//
// 2026-10-27 (hunt 8): the press was `update read_at where read_at is null` - every unread
// row on the server. The list is up to 45 s old (a poll, no realtime), so an approval or a
// feedback reply that landed since the last load went straight to read on every device
// without ever having been on screen or lit the badge. The write now names the unread ids
// in the list; the optimistic update and its rollback cover the same ids.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { NotificationBell } from "@/components/notifications/notification-bell";

const row = (id: string, read_at: string | null) => ({
  id,
  type: "event_approved",
  title: "✅ อนุมัติงานแล้ว",
  body: null,
  link: null,
  read_at,
  created_at: "2026-10-27T10:00:00.000Z",
});

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      // the mount's load (two unread, one read), then the mark-all update's rows back
      notifications: [
        ok([row("n1", null), row("n2", null), row("n3", "2026-10-27T09:00:00.000Z")]),
        ok([{ id: "n1" }, { id: "n2" }]),
      ],
      events: ok([]),
    },
  });
  h.supa = supa;
});
afterEach(() => cleanup());

describe("อ่านทั้งหมด", () => {
  it("writes read_at only on the unread rows the list shows, never on a row it has not shown", async () => {
    await act(async () => {
      render(<NotificationBell userId="u1" tenantId="t1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /การแจ้งเตือน/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /อ่านทั้งหมด/ }));
    });
    const [update] = supa.callsTo("notifications", "update");
    expect(update).toBeTruthy();
    const byId = update.filters.find((f) => f.op === "in" && f.column === "id");
    expect(byId?.value).toEqual(["n1", "n2"]);
    // the badge went with them
    expect(screen.queryByRole("button", { name: /อ่านทั้งหมด/ })).toBeNull();
  });
});
