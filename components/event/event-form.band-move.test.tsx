// 2026-10-27 hunt 6 (sec-1): the edit form moved a show to another band with no check. Its
// setlist's library songs and its lineup stayed the old band's, and every read of them is
// band-scoped - so after บันทึก every linked row played SILENT on stage, on every device, and
// the lineup came up empty. A show that holds the old band's songs or people now stays put;
// an empty one still moves.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard } from "@/lib/dirty-guard";

const h = vi.hoisted(() => ({
  counts: { setlist_items: 0, event_members: 0 } as Record<string, number>,
  fail: false,
  writes: [] as Record<string, unknown>[],
  errors: [] as unknown[][],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "is"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          h.fail
            ? { count: null, error: { message: "Failed to fetch" } }
            : { count: h.counts[table] ?? 0, error: null }
        ).then(res);
      return b;
    },
  }),
}));
vi.mock("@/lib/mgmt-write", () => ({
  saveEventWrite: vi.fn(async (args: { payload: Record<string, unknown>; eventId: string }) => {
    h.writes.push(args.payload);
    return { ok: true, id: args.eventId, queued: false };
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn((...a: unknown[]) => h.errors.push(a)),
    info: vi.fn(),
  },
}));
// Radix Select does not open in jsdom: a native <select> with the same value/onValueChange
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

import { EventForm } from "@/components/event/event-form";

const opened = {
  id: "e1", tenant_id: "t1", group_id: "gA", name: "งานทดสอบ", event_date: "2026-12-01",
  venue: "Hall", event_type: "idol", show_start_time: "17:00:00",
  hard_out_time: "17:20:00", status: "draft", notes: null, map_url: null, costume_theme: null,
  deadline: null, deadline_note: null, updated_at: "2026-10-26T00:00:00Z",
};

beforeEach(() => {
  h.counts = { setlist_items: 0, event_members: 0 };
  h.fail = false;
  h.writes = [];
  h.errors = [];
});
afterEach(() => {
  cleanup();
  resetDirtyGuard();
});

async function moveToBandB() {
  render(
    <ConfirmProvider>
      <EventForm mode="edit" tenantId="t1" userId="u1"
        groups={[{ id: "gA", name: "Band A" } as never, { id: "gB", name: "Band B" } as never]}
        event={opened as never} />
    </ConfirmProvider>
  );
  const band = screen
    .getAllByRole("combobox")
    .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === "gB"))!;
  fireEvent.change(band, { target: { value: "gB" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
  });
}

describe("EventForm edit — moving a show to another band", () => {
  it("refuses while the setlist holds the old band's library songs, and says why", async () => {
    h.counts = { setlist_items: 12, event_members: 0 };
    await moveToBandB();
    expect(h.writes).toHaveLength(0);
    expect(h.errors[0]?.[0]).toBe("ย้ายวงไม่ได้");
    expect(String((h.errors[0]?.[1] as { description?: string })?.description)).toContain("เพลงในเซ็ตลิสต์ 12 เพลง");
  });

  it("refuses while the lineup holds the old band's people", async () => {
    h.counts = { setlist_items: 0, event_members: 4 };
    await moveToBandB();
    expect(h.writes).toHaveLength(0);
    expect(String((h.errors[0]?.[1] as { description?: string })?.description)).toContain("ไลน์อัป 4 คน");
  });

  it("refuses when it cannot check - a failed read is not 'nothing there'", async () => {
    h.fail = true;
    await moveToBandB();
    expect(h.writes).toHaveLength(0);
    expect(h.errors[0]?.[0]).toBe("ย้ายวงไม่ได้");
  });

  it("still moves an empty show (the wrong band picked a minute ago)", async () => {
    await moveToBandB();
    expect(h.writes).toEqual([expect.objectContaining({ group_id: "gB" })]);
  });
});
