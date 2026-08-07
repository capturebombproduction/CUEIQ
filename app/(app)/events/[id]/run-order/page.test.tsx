import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import RunOrderPage from "@/app/(app)/events/[id]/run-order/page";
import { RunOrderBuilder } from "@/components/event/run-order-builder";

// The running-order BUILDER is the sharpest case in this area. It already carries
// an explicit guard saying an empty read is not proof the order is gone — because
// the next "นำเข้าจากเวทีวง" reads linked_event_id off those very rows and would
// insert every act a second time and broadcast the duplicate to the live board.
// The read that SEEDS it had no guard at all: `seqs ?? []` handed the component
// exactly the empty list it was written never to believe.
const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown, ev: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));
vi.mock("@/lib/queries", () => ({
  getWorkspace: async () => h.ws,
  getEventRow: async () => h.ev,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/event/run-order-builder", () => ({ RunOrderBuilder: () => null }));

interface Elementish {
  type?: unknown;
  props?: Record<string, unknown>;
}

function findEl(node: unknown, type: unknown): Elementish | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findEl(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as Elementish;
  if (el.type === type) return el;
  return el.props ? findEl(el.props.children, type) : null;
}

const EVENT_ID = "9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e";
const call = () =>
  RunOrderPage({
    params: Promise.resolve({ id: EVENT_ID }),
    searchParams: Promise.resolve({ from: "overview" }),
  });

/** Every table this page reads. A fourth read added without a guard entry fails
 *  the tripwire test below. */
const READS = ["events", "schedule_items", "run_sequence"];

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      events: ok([{ id: EVENT_ID, group_id: "g1" }]),
      schedule_items: ok([
        { event_id: EVENT_ID, start_time: "18:00:00", end_time: "18:40:00" },
      ]),
      run_sequence: ok([]),
    },
  });
  h.supa = supa;
  h.ev = {
    id: EVENT_ID,
    tenant_id: "t1",
    group_id: "g1",
    name: "A Lot Of Tone Fest",
    event_date: "2026-08-09",
  };
  h.ws = {
    user: { id: "u1", email: "staff@cueiq.local", name: "Staff" },
    membership: { tenant_id: "t1", role: "admin" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [{ id: "g1", name: "Seishin Kakumei" }],
    groupRoles: [],
    perms: makePerms("admin"),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunOrderPage — a failed read is not a zero count", () => {
  for (const table of READS) {
    it(`throws instead of seeding an empty builder when the ${table} read fails`, async () => {
      supa.setTable(table, fail(`boom-${table}`, 500));
      await expect(call()).rejects.toMatchObject({
        name: "ReadFailedError",
        message: expect.stringContaining(`boom-${table}`) as unknown as string,
      });
      expect(console.error).toHaveBeenCalled();
    });
  }

  it("covers every table the page reads — a fourth read must fail this test", async () => {
    await call();
    const touched = Array.from(new Set(supa.calls.map((c) => c.table))).sort();
    expect(touched).toEqual([...READS].sort());
  });

  it("never seeds the builder from a failed run_sequence read", async () => {
    // The duplication path stated as an assertion: if this page ever swallows the
    // error again, the builder is handed [] and the next import doubles the show.
    supa.setTable("run_sequence", fail("boom-run_sequence", 500));
    await expect(call()).rejects.toThrow();
    expect(supa.callsTo("run_sequence")).toHaveLength(1);
  });
});

describe("RunOrderPage — an empty read is still an empty order", () => {
  it("seeds an empty builder for a festival whose order has not been built yet", async () => {
    const tree = await call();
    const builder = findEl(tree, RunOrderBuilder);
    expect(builder).not.toBeNull();
    expect(builder!.props!.initial).toEqual([]);
    // …and the band list is still there, so "นำเข้าจากเวทีวง" has something to import.
    expect((builder!.props!.bandEvents as unknown[]).length).toBe(1);
  });

  it("passes the real rows through when the order exists", async () => {
    const rows = [{ id: "r1", sort_order: 1, title: "วงแรก" }];
    supa.setTable("run_sequence", ok(rows));
    const tree = await call();
    const builder = findEl(tree, RunOrderBuilder);
    expect(builder!.props!.initial).toEqual(rows);
  });

  it("skips the stage read entirely when the festival has no events", async () => {
    // The `ids.length ? … : { data: [], error: null }` branch: a read that was
    // never attempted must not be invented as a failure.
    supa.setTable("events", ok([]));
    const tree = await call();
    expect(supa.callsTo("schedule_items")).toHaveLength(0);
    expect(findEl(tree, RunOrderBuilder)!.props!.bandEvents).toEqual([]);
  });
});
