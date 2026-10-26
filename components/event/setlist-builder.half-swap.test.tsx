// A reorder is several independent UPDATEs (Promise.all): ▲/▼ writes two rows, a renumber
// (drag & drop, or ▲/▼ across a sort_order tie) writes every row that moved. When ONE of
// them LANDS and another comes back with an ERROR (a 503 / timeout on venue wifi), the
// error branch put the pre-edit order back on screen and broadcast nothing - while the DB
// held the half-swap: two rows on ONE sort_order, which Live Mode orders by uuid. The
// 0-row twin of exactly this case already re-read the server; the error twin did not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  fail,
  type SupabaseFake,
  type RecordedCall,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

function item(id: string, sort_order: number, title: string): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: 200,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
  };
}

// ids chosen so a tie sorts by id the other way round from the screen's order
const A_ID = "ffffffff-0000-4000-8000-000000000001";
const B_ID = "00000000-0000-4000-8000-000000000002";
const C_ID = "11111111-0000-4000-8000-000000000003";

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => cleanup());

/** A setlist_items table where the writes to `failing` ids come back 503. */
function serverWith(db: SetlistItem[], failing: string[]) {
  supa.setTable("setlist_items", (call: RecordedCall) => {
    if (call.verb === "update") {
      if (failing.includes(call.eq.id as string)) return fail("Service Unavailable", 503);
      const row = db.find((r) => r.id === call.eq.id)!;
      Object.assign(row, call.values as object);
      return ok([{ id: row.id }]);
    }
    // reads: the server's order, ties by id (lib/queries.ts, live-mode.tsx)
    return ok([...db].sort((x, y) => x.sort_order - y.sort_order || (x.id < y.id ? -1 : 1)));
  });
}

const serverOrder = (db: SetlistItem[]) =>
  [...db]
    .sort((x, y) => x.sort_order - y.sort_order || (x.id < y.id ? -1 : 1))
    .map((r) => r.title);
const onScreen = () =>
  (screen.getAllByRole("textbox", { name: "ชื่อเพลง / หัวข้อ" }) as HTMLInputElement[]).map(
    (i) => i.value
  );

function mount(initial: SetlistItem[]) {
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={initial}
        showStartTime="19:00"
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Show"
      />
    </ConfirmProvider>
  );
}

describe("setlist reorder when one write errors and another lands", () => {
  it("▲/▼: shows the order the server now holds, not the pre-swap one", async () => {
    const A = item(A_ID, 1, "Opener A");
    const B = item(B_ID, 2, "Second B");
    const db = [{ ...A }, { ...B }];
    serverWith(db, [B_ID]); // A's write lands, B's comes back 503
    mount([A, B]);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(2));
    await act(async () => {});

    // the server now: A=2, B=2 → played B, A
    expect(serverOrder(db)).toEqual(["Second B", "Opener A"]);
    await waitFor(() => expect(onScreen()).toEqual(serverOrder(db)));
  });

  it("renumber (▲/▼ across a tie): shows the order the server now holds", async () => {
    const A = item(A_ID, 1, "A");
    const B = item(B_ID, 1, "B");
    const C = item(C_ID, 1, "C");
    const db = [{ ...A }, { ...B }, { ...C }];
    serverWith(db, [C_ID]); // A → 2 lands, C → 3 comes back 503
    mount([A, B, C]);
    expect(onScreen()).toEqual(["A", "B", "C"]);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(2));
    await act(async () => {});

    expect(serverOrder(db)).toEqual(["B", "C", "A"]);
    await waitFor(() => expect(onScreen()).toEqual(serverOrder(db)));
  });

  it("when no write landed the pre-swap order comes back, without a re-read", async () => {
    const A = item(A_ID, 1, "Opener A");
    const B = item(B_ID, 2, "Second B");
    const db = [{ ...A }, { ...B }];
    serverWith(db, [A_ID, B_ID]);
    mount([A, B]);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(2));
    await act(async () => {});

    expect(onScreen()).toEqual(["Opener A", "Second B"]);
    expect(supa.callsTo("setlist_items", "select")).toEqual([]);
  });
});
