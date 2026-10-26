// 2026-10-27 hunt (setlist): job 2, pre-existing.
// setlist-builder move() renumbers only when the TWO swapped rows share a sort_order
// (`if (a.sort_order === b.sort_order)`); any other tie in the set survives a swap and
// can be CREATED by one: [A:1, B:2, C:2] and A ▼ → A=2, B=1 → A and C both on 2. The
// builder shows B, A, C (stable sort of its own array); Live Mode and every other
// device read ORDER BY sort_order, id and play C before A when C's uuid is lower.
// run-order-builder got the "any tie → renumber 1..n" rule today (c4388cf,
// hasRunOrderTie); the setlist builder did not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
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

// ids chosen so C sorts BEFORE A by uuid; B < C so the server's (sort_order,id) read
// hands the builder [A, B, C]
const A = item("cccccccc-0000-4000-8000-000000000001", 1, "Song A");
const B = item("10000000-0000-4000-8000-000000000002", 2, "Song B");
const C = item("20000000-0000-4000-8000-000000000003", 2, "Song C");

let supa: SupabaseFake;
let server: SetlistItem[];
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [A, B, C].map((r) => ({ ...r }));
  supa.setTable("setlist_items", (call) => {
    if (call.verb === "update") {
      const r = server.find((x) => x.id === call.eq.id);
      if (!r) return ok([]);
      Object.assign(r, call.values as object);
      return ok([{ id: r.id }]);
    }
    if (call.verb === "select") return ok(server.map((r) => ({ ...r })));
    return ok([]);
  });
});
afterEach(() => cleanup());

describe("SetlistBuilder — ▲▼ beside a tie renumbers, so the builder and Live agree", () => {
  it("after A ▼ the server's (sort_order, id) order is the order on screen", async () => {
    render(
      <ConfirmProvider>
        <SetlistBuilder
          eventId={EVENT_ID}
          tenantId={TENANT_ID}
          editable
          initialItems={[A, B, C]}
          showStartTime={null}
          hardOutTime={null}
          members={[]}
          songs={[]}
          eventName="Show"
        />
      </ConfirmProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]); // A ▼
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update").length).toBeGreaterThan(0));
    await act(async () => {});
    const onScreen = (screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[]).map(
      (i) => i.value
    );
    // what Live Mode reads (lib/queries.ts / live-mode refetch: sort_order, then id)
    const live = [...server]
      .sort((x, y) => x.sort_order - y.sort_order || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((r) => r.title);
    expect(onScreen).toEqual(["Song B", "Song A", "Song C"]);
    expect(live).toEqual(onScreen);
  });
});
