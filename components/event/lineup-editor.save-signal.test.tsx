// The Lineup tab's writes were invisible to the page's save bookkeeping (lib/dirty-guard.ts,
// via useSaveSignal): "บันทึก / อัปเดต" and the Summary switch refresh the page once nothing is
// pending, and a lineup toggle still on the wire was not "pending" - the refresh could read the
// half-saved list and re-seed both the Lineup panel and the Mics tab from it. Every lineup write
// now begins and ends like the other editors' writes, and the tab says บันทึกแล้ว / ยังไม่ได้บันทึก.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, fail } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { LineupEditor } from "@/components/event/lineup-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";

const member = (n: number): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});

let supa: SupabaseFake;
const mount = () =>
  render(
    <ConfirmProvider>
      <LineupEditor eventId="e1" tenantId="t1" editable members={[1, 2, 3].map(member)} initialLineup={["m1", "m2", "m3"]} />
    </ConfirmProvider>
  );

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  resetDirtyGuard();
  toast.error.mockClear();
});
afterEach(() => resetDirtyGuard());

describe("LineupEditor · its writes are pending work the page can see", () => {
  it("a toggle on the wire is pending; when it lands nothing is, and the tab says บันทึกแล้ว", async () => {
    const held = supa.defer("event_members");
    mount();
    await userEvent.click(screen.getByRole("button", { name: /นิค2/ }));
    await waitFor(() => expect(held.taken).toBe(true));
    expect(unsavedWork().pending).toBe(1);
    held.resolve({ data: null, error: null, status: 204 });
    await waitFor(() => expect(unsavedWork().pending).toBe(0));
    expect(unsavedWork().failed).toBe(0);
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("a refused write is counted as failed (the leave-guard can warn) and the tab says so", async () => {
    supa.setScript({ event_members: fail("permission denied", 403) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: /นิค2/ }));
    await waitFor(() => expect(unsavedWork().failed).toBe(1));
    expect(unsavedWork().pending).toBe(0);
    expect(screen.getByText("ยังไม่ได้บันทึก")).toBeTruthy();
  });
});
