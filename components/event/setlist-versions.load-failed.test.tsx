// The version list ignored its read's error: a failed read showed "ยังไม่มีเวอร์ชันที่
// บันทึกไว้" - telling the Ar that the versions she saved are gone - with no way to ask
// again short of closing and reopening the dialog.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { SetlistVersions } from "@/components/event/setlist-versions";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";
const VERSION = {
  id: "v1",
  label: "ก่อนซ้อม",
  created_at: "2026-10-20T10:00:00Z",
  snapshot: [],
};

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => cleanup());

async function open() {
  render(
    <SetlistVersions eventId={EVENT_ID} tenantId={TENANT_ID} items={[]} onRestore={async () => {}} />
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ประวัติ\/เวอร์ชัน/ }));
  });
  return screen.getByRole("dialog");
}

describe("setlist version list: a read that failed", () => {
  it("says it failed and offers ลองใหม่ - not 'no versions'", async () => {
    supa.setScript({ setlist_versions: fail("TypeError: Failed to fetch", 0) });
    const dialog = await open();
    expect(dialog.textContent).not.toMatch(/ยังไม่มีเวอร์ชันที่บันทึกไว้/);
    expect(screen.getByRole("alert").textContent).toMatch(/โหลดประวัติเวอร์ชันไม่สำเร็จ/);
    expect(screen.getByRole("button", { name: /ลองใหม่/ })).toBeTruthy();
  });

  it("ลองใหม่ reads again and shows the saved versions", async () => {
    supa.setTable("setlist_versions", [fail("Service Unavailable", 503), ok([VERSION])]);
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ลองใหม่/ }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("ก่อนซ้อม")).toBeTruthy();
  });

  it("an empty history is still said plainly", async () => {
    supa.setScript({ setlist_versions: ok([]) });
    const dialog = await open();
    expect(dialog.textContent).toMatch(/ยังไม่มีเวอร์ชันที่บันทึกไว้/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
