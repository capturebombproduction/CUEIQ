// Two running-order rows on ONE sort_order. The builder numbered a new row from its
// own rows (never re-read), so two staff screens adding at once gave both new rows
// the same number; its swap-based ▲/▼ then wrote both rows the same value - a press
// that did nothing. lib/run-order-sort.ts has the one order every screen uses.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { RunOrderBuilder, type RunSequence } from "@/components/event/run-order-builder";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const FEST = "A Lot Of Tone Fest";
let supa: SupabaseFake;

function seq(over: Partial<RunSequence> & { id: string }): RunSequence {
  return {
    tenant_id: "t1",
    event_name: FEST,
    event_date: "2026-08-09",
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    ...over,
  };
}

/** A tiny run_sequence table: inserts land, selects read it highest-first. */
function serverTable(db: RunSequence[]) {
  let n = 0;
  return (call: RecordedCall) => {
    if (call.verb === "insert") {
      const row = { ...seq({ id: `new-${++n}` }), ...(call.values as object) } as RunSequence;
      db.push(row);
      return ok(row);
    }
    if (call.verb === "update") {
      const row = db.find((r) => r.id === call.eq.id);
      if (row) Object.assign(row, call.values as object);
      return ok(row ? [{ id: row.id }] : []);
    }
    return ok([...db].sort((a, b) => b.sort_order - a.sort_order));
  };
}

function mount(initial: RunSequence[]) {
  return render(
    <ConfirmProvider>
      <RunOrderBuilder tenantId="t1" eventName={FEST} eventDate="2026-08-09" initial={initial} bandEvents={[]} />
    </ConfirmProvider>
  );
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("run order builder: no two rows on one number", () => {
  it("two screens opened on the same order and both adding get DIFFERENT numbers", async () => {
    const base = [seq({ id: "r1", sort_order: 1, title: "A" }), seq({ id: "r2", sort_order: 2, title: "B" })];
    const db = base.map((r) => ({ ...r }));
    supa.setTable("run_sequence", serverTable(db));
    const one = mount(base);
    fireEvent.click(screen.getByRole("button", { name: /เพิ่มลำดับ/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "insert")).toHaveLength(1));
    one.unmount();
    mount(base); // the second screen still holds the 2-row copy
    fireEvent.click(screen.getByRole("button", { name: /เพิ่มลำดับ/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "insert")).toHaveLength(2));
    const sorts = supa.callsTo("run_sequence", "insert").map((c) => (c.values as RunSequence).sort_order);
    expect(sorts).toEqual([3, 4]);
  });

  it("a failed max read still numbers from this screen's rows", async () => {
    supa.setTable("run_sequence", (call) =>
      call.verb === "insert"
        ? ok({ ...seq({ id: "n" }), ...(call.values as object) })
        : { data: null, error: { message: "Failed to fetch", code: "" } }
    );
    mount([seq({ id: "r1", sort_order: 7 })]);
    fireEvent.click(screen.getByRole("button", { name: /เพิ่มลำดับ/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "insert")).toHaveLength(1));
    expect((supa.callsTo("run_sequence", "insert")[0].values as RunSequence).sort_order).toBe(8);
  });

  it("▲ on a row tied with its neighbour really moves it (the order is renumbered)", async () => {
    const rows = [
      seq({ id: "r1", sort_order: 1, title: "Opening" }),
      seq({ id: "r2", sort_order: 2, title: "Break" }),
      seq({ id: "r3", sort_order: 2, title: "Game" }), // tie with r2
      seq({ id: "r4", sort_order: 3, title: "Seishin" }),
    ];
    const db = rows.map((r) => ({ ...r }));
    supa.setTable("run_sequence", serverTable(db));
    mount(rows);
    const ups = screen.getAllByRole("button", { name: "เลื่อนขึ้น" });
    fireEvent.click(ups[2]); // "Game" up past "Break"
    await waitFor(() => expect(supa.callsTo("run_sequence", "update").length).toBeGreaterThan(0));
    const order = [...db].sort((a, b) => a.sort_order - b.sort_order).map((r) => [r.title, r.sort_order]);
    expect(order).toEqual([
      ["Opening", 1],
      ["Game", 2],
      ["Break", 3],
      ["Seishin", 4],
    ]);
  });

  it("an order without ties still swaps just the two rows", async () => {
    const rows = [seq({ id: "r1", sort_order: 1 }), seq({ id: "r2", sort_order: 5 }), seq({ id: "r3", sort_order: 9 })];
    supa.setTable("run_sequence", serverTable(rows.map((r) => ({ ...r }))));
    mount(rows);
    fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนขึ้น" })[2]);
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(2));
    const written = new Map(
      supa.callsTo("run_sequence", "update").map((c) => [c.eq.id, (c.values as RunSequence).sort_order])
    );
    expect(written).toEqual(
      new Map([
        ["r2", 9],
        ["r3", 5],
      ])
    );
  });
});
