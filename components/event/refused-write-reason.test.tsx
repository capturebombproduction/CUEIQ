// A refused write must say why (hunt 5, the class hunt 4 fixed in three other toasts).
//
// supabase-js reports a refusal as `error`, a plain object - not an Error. Restoring a
// setlist version (restoreSnapshot rethrows that object) and creating a practice room
// (`throw error ?? new Error(…)`) caught it with `e instanceof Error ? e.message :
// undefined`, so an RLS / guard-trigger refusal showed "…ไม่สำเร็จ" with no reason.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, fail } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: h.toastError, info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { SetlistVersions } from "@/components/event/setlist-versions";
import { CreatePracticeButton } from "@/components/practice/create-practice-button";

const REASON = "เหตุผลจากเซิร์ฟเวอร์";

beforeEach(() => {
  h.toastError.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("restoring a setlist version the server refused", () => {
  it("says why", async () => {
    const supa = makeSupabaseFake({ session: makeSession() });
    supa.setScript({
      setlist_versions: {
        data: [{ id: "v1", label: "ก่อนซ้อม", created_at: "2026-10-20T10:00:00Z", snapshot: [] }],
        error: null,
        status: 200,
      },
    });
    h.supa = supa;
    // what restoreSnapshot throws: PostgREST's own error object
    const onRestore = vi.fn(async () => {
      throw { message: REASON, code: "42501", details: null, hint: null };
    });
    render(<SetlistVersions eventId="e1" tenantId="t1" items={[]} onRestore={onRestore} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ประวัติ\/เวอร์ชัน/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /กู้คืน/ }));
    });
    expect(onRestore).toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith("กู้คืนไม่สำเร็จ", { description: REASON });
  });
});

describe("creating a practice room the server refused", () => {
  it("says why", async () => {
    h.supa = makeSupabaseFake({ session: makeSession(), script: { events: fail(REASON) } });
    render(<CreatePracticeButton tenantId="t1" userId="u1" groups={[{ id: "g1", name: "วงทดสอบ" }]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /สร้างห้องซ้อม/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^สร้าง$/ }));
    });
    expect(h.toastError).toHaveBeenCalledWith("สร้างห้องซ้อมไม่สำเร็จ", { description: REASON });
  });
});
