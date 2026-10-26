// The Excel run sheet could list two rows in a different order than Live Mode.
//
// Two setlist rows can share a sort_order ("two rows added at once", lib/queries.ts),
// and every surface that PLAYS or EDITS the set breaks that tie by id so all devices
// agree: getEventBundle, Live Mode, the setlist builder ("ties read the same as Live").
// The export re-read the setlist with `.order("sort_order")` only — Postgres then
// returns tied rows in whatever order the heap gives, so the printed sheet the crew
// holds could swap two songs relative to what Live Mode plays.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, emitted: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/export-excel", () => ({
  downloadRunSheet: (data: unknown) => {
    h.emitted.push(data);
  },
}));

import { ExportButton } from "@/components/event/export-button";

let supa: SupabaseFake;
beforeEach(() => {
  h.emitted = [];
  supa = makeSupabaseFake({
    script: {
      events: ok({ name: "งานทดสอบ", event_date: null, venue: null, show_start_time: null, hard_out_time: null, notes: null, costume_theme: null }),
      "*": ok([]),
    },
  });
  h.supa = supa;
});

describe("ExportButton · the setlist read", () => {
  it("asks for Live Mode's total order: sort_order, then id", async () => {
    render(<ExportButton eventId="e1" groupId="g1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    await waitFor(() => expect(h.emitted).toHaveLength(1));
    const call = supa.calls.find((c) => c.table === "setlist_items")!;
    const orders = call.modifiers.filter((m) => m.op === "order").map((m) => m.args[0]);
    expect(orders).toEqual(["sort_order", "id"]);
  });
});
