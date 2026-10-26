// A new setlist row is numbered max(sort_order)+1. Numbered from this screen's own copy
// alone - never re-seeded while its tab is open (event-workspace re-keys only HIDDEN
// panels) - an Ar on the laptop and a staffer on a phone, both on the Setlist tab, each
// adding a row (or "จากคลัง") gave both new rows the SAME sort_order. Live Mode then
// orders the two by uuid, not by who added what, while each editor shows its own row
// last: the printed sheet and the stage disagree. The server's highest number is read
// just before the insert now, as run-order-builder's lastSortOrder() does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
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

/** A tiny setlist_items table: inserts land, selects read it highest-first. */
function serverTable(db: SetlistItem[]) {
  let n = 0;
  return (call: RecordedCall) => {
    if (call.verb === "insert") {
      const row = { ...item(`new-${++n}`, 0, ""), ...(call.values as object) } as SetlistItem;
      db.push(row);
      return ok(row);
    }
    return ok([...db].sort((a, b) => b.sort_order - a.sort_order));
  };
}

function mount(initial: SetlistItem[]) {
  return render(
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

const insertedSorts = (s: SupabaseFake) =>
  s.callsTo("setlist_items", "insert").map((c) => (c.values as { sort_order: number }).sort_order);

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => cleanup());

describe("setlist builder: numbering a new row", () => {
  it("two screens adding at once give their new rows DIFFERENT sort_orders", async () => {
    const base = [item("r1", 1, "A"), item("r2", 2, "B")];
    const db = base.map((r) => ({ ...r }));
    supa.setTable("setlist_items", serverTable(db));

    const one = mount(base);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^เพลง$/ }));
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
    one.unmount();

    mount(base); // the second screen still holds the 2-row copy
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^เพลง$/ }));
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(2));

    expect(insertedSorts(supa)).toEqual([3, 4]);
  });

  it("falls back to this screen's own numbering when the read fails", async () => {
    supa.setTable("setlist_items", (call: RecordedCall) =>
      call.verb === "insert"
        ? ok({ ...item("new-1", 0, ""), ...(call.values as object) })
        : fail("Service Unavailable", 503)
    );
    mount([item("r1", 1, "A"), item("r2", 5, "B")]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^เพลง$/ }));
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
    expect(insertedSorts(supa)).toEqual([6]);
  });
});
