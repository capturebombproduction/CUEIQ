import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// DELETING A BAND'S SHOW LEAVES ITS LINE ON THE FESTIVAL BOARD (2026-10-30, hunt 11).
//
// run_sequence.linked_event_id is `on delete set null` (0033): deleting a band's event -
// the way a show is cancelled - keeps that band's line on the festival running order,
// unlinked, so the caller still calls a band that is no longer on the show, and re-adding
// the band later gives it a second line. The confirm never mentioned the board. It now
// counts the linked lines (best-effort, bounded) and says so; the delete is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  supa: null as unknown,
  confirm: vi.fn<(opts: { description?: string }) => Promise<boolean>>(async () => true),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => h.confirm }));

import { DeleteEventButton } from "@/components/event/delete-event-button";

const SENTENCE = "บอร์ดคิวเทศกาล";

let supa: SupabaseFake;
function setup(board: Parameters<SupabaseFake["setTable"]>[1]) {
  supa = makeSupabaseFake({ script: { events: ok([{ id: "e1" }]) } });
  supa.setTable("run_sequence", board);
  h.supa = supa;
}
beforeEach(() => h.confirm.mockClear());
afterEach(() => vi.useRealTimers());

const deletes = () => supa.calls.filter((c) => c.table === "events" && c.verb === "delete");
const asked = () => String(h.confirm.mock.calls[0]?.[0]?.description ?? "");

async function press() {
  render(<DeleteEventButton eventId="e1" eventName="SPORT DAY" />);
  await act(async () => {
    fireEvent.click(screen.getByTitle("ลบงานนี้"));
  });
}

describe("DeleteEventButton — the festival board line it leaves behind", () => {
  it("says how many board lines stay when the band has some, then deletes as before", async () => {
    setup(ok([], { count: 2 }));
    await press();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(asked()).toContain(SENTENCE);
    expect(asked()).toContain("2 แถว");
    const [count] = supa.callsTo("run_sequence", "select");
    expect(count.eq).toMatchObject({ linked_event_id: "e1" });
    // and the board itself is never written from here
    expect(supa.calls.filter((c) => c.table === "run_sequence" && c.verb !== "select")).toEqual([]);
  });

  it("says nothing extra for a show with no board line", async () => {
    setup(ok([], { count: 0 }));
    await press();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(asked()).not.toContain(SENTENCE);
    expect(asked()).toContain("ไฟล์เพลงในคลังไม่ถูกลบ");
  });

  it("a failed count says nothing and still asks", async () => {
    setup(fail("permission denied", 403));
    await press();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(asked()).not.toContain(SENTENCE);
  });

  it("a count that never answers holds the confirm back 3 s at most", async () => {
    vi.useFakeTimers();
    supa = makeSupabaseFake({ script: { events: ok([{ id: "e1" }]) } });
    supa.defer("run_sequence"); // never resolved
    h.supa = supa;
    render(<DeleteEventButton eventId="e1" eventName="SPORT DAY" />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("ลบงานนี้"));
    });
    expect(h.confirm).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(asked()).not.toContain(SENTENCE);
  });
});
