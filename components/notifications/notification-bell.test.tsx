// The bell's panel, as a touch target. Its "อ่านทั้งหมด" was a 72 × 16 px text link
// on a phone — the only control in the restyled shell under 44 px, sitting right
// under the thumb that opened the bell. jsdom cannot measure, so this pins the
// height class that makes it 44 (h-11), and that the press still does its job.
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

const UNREAD = {
  id: "n1",
  type: "reminder",
  title: "โชว์พรุ่งนี้",
  body: null,
  link: null,
  read_at: null,
  created_at: "2026-10-01T10:00:00.000Z",
};

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      // first: the mount's load; then the mark-all update, which asks for its rows back
      notifications: [ok([UNREAD]), ok([{ id: "n1" }])],
      events: ok([]),
    },
  });
  h.supa = supa;
});
afterEach(() => cleanup());

async function openPanel() {
  await act(async () => {
    render(<NotificationBell userId="u1" tenantId="t1" />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /การแจ้งเตือน/ }));
  });
}

describe("NotificationBell panel", () => {
  it("อ่านทั้งหมด is a 44 px-tall target, and still marks everything read", async () => {
    await openPanel();
    const markAll = screen.getByRole("button", { name: /อ่านทั้งหมด/ });
    expect((markAll.getAttribute("class") ?? "").split(/\s+/)).toContain("h-11");
    await act(async () => {
      fireEvent.click(markAll);
    });
    // nothing unread is left, so the control goes with it
    expect(screen.queryByRole("button", { name: /อ่านทั้งหมด/ })).toBeNull();
  });
});
