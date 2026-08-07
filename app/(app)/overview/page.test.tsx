import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import OverviewPage from "@/app/(app)/overview/page";
import { OverviewClient } from "@/components/overview/overview-client";

// /overview is an async Server Component: it is CALLED, not rendered. That is the
// point — round 10's most common defect was a fix that could not execute, and the
// only way to prove a guard runs is to enter the page the way Next does and follow
// what comes back. No DOM, no testing-library, no rendering of the client tree.
const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// The two leaves. Stubbed so this file tests the page's own read/guard logic and
// nothing of the client board; the stub identity is also how the props below are
// found in the returned element tree.
vi.mock("@/components/overview/overview-client", () => ({ OverviewClient: () => null }));
vi.mock("@/components/join-demo", () => ({ JoinDemo: () => null }));

interface Elementish {
  type?: unknown;
  props?: Record<string, unknown>;
}

/** Find the element of a given component type in a returned (unrendered) tree. */
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

const GROUP = {
  id: "g1",
  tenant_id: "t1",
  name: "Seishin Kakumei",
  color: "#A62A1C",
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  skin: null,
};

const evRow = (id: string, event_date: string | null) => ({
  id,
  tenant_id: "t1",
  group_id: "g1",
  name: "A Lot Of Tone Fest",
  event_date,
  status: "approved",
  deadline: null,
  notes: null,
  is_template: false,
  is_practice: false,
});

// One dated and one undated event on purpose: run_sequence keys on the festival
// (name + date), so the undated one is what makes readRunOrders issue its second,
// `is("event_date", null)` read. Both must be covered by the guard.
const EVENTS = [evRow("e1", "2026-08-09"), evRow("e2", null)];

/** Every table /overview reads. The tripwire test below pins this list, so a NINTH
 *  read added without a guard entry fails here rather than at a festival. */
const READS = [
  "events",
  "members",
  "songs",
  "staff_contacts",
  "schedule_items",
  "setlist_items",
  "run_sequence",
  "mic_assignments",
];

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      events: ok(EVENTS),
      members: ok([]),
      songs: ok([]),
      staff_contacts: ok([]),
      schedule_items: ok([]),
      setlist_items: ok([]),
      run_sequence: ok([]),
      mic_assignments: ok([]),
    },
  });
  h.supa = supa;
  h.ws = {
    user: { id: "u1", email: "admin@cueiq.local", name: "Admin" },
    membership: { tenant_id: "t1", role: "admin" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [GROUP],
    groupRoles: [],
    perms: makePerms("admin"),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OverviewPage — a failed read is not a zero count", () => {
  // One case per read. Each scripts a UNIQUE ascii marker so the assertion proves
  // it was THAT read the guard caught, without matching Thai display copy.
  for (const table of READS) {
    it(`throws instead of rendering zeroes when the ${table} read fails`, async () => {
      supa.setTable(table, fail(`boom-${table}`, 500));
      await expect(OverviewPage()).rejects.toMatchObject({
        name: "ReadFailedError",
        message: expect.stringContaining(`boom-${table}`) as unknown as string,
      });
      // The cause must reach the server log — in production the digest is all the
      // user gets, and this line is the only way to match it back to a cause.
      expect(console.error).toHaveBeenCalled();
    });
  }

  it("covers every table the page reads — a ninth read must fail this test", async () => {
    await OverviewPage();
    const touched = Array.from(new Set(supa.calls.map((c) => c.table))).sort();
    expect(touched).toEqual([...READS].sort());
  });

  it("fails on a read that errored only on a LATER page (the paged path)", async () => {
    // readPaged loops. A tenant big enough to need a second round trip can fail on
    // it, and the first page's rows would otherwise be handed on as the whole set.
    const page1 = Array.from({ length: 1000 }, () => ({ event_id: "e1" }));
    supa.setTable("mic_assignments", [
      ok(page1, { count: 4000 }),
      fail("boom-page-two", 500),
    ]);
    await expect(OverviewPage()).rejects.toMatchObject({ name: "ReadFailedError" });
  });
});

describe("OverviewPage — an empty read is still an empty board", () => {
  // The guard rail on the fix. "Throw when a read failed" must never drift into
  // "throw when a read is empty": every one of these is a legitimate empty state.
  it("renders a festival that genuinely has no running order yet", async () => {
    const tree = await OverviewPage();
    const board = findEl(tree, OverviewClient);
    expect(board).not.toBeNull();
    expect(board!.props!.runOrderFestivals).toEqual([]);
    expect((board!.props!.events as unknown[]).length).toBe(EVENTS.length);
    expect(board!.props!.staffContacts).toEqual([]);
  });

  it("renders the no-bands empty state instead of the board", async () => {
    (h.ws as { groups: unknown[] }).groups = [];
    const tree = await OverviewPage();
    expect(findEl(tree, OverviewClient)).toBeNull();
  });

  it("still counts a festival that DOES have a running order", async () => {
    // Proves runOrderFestivals is built from the read the guard now protects —
    // i.e. the "คุมคิว (Live)" entry appears when, and only when, the rows say so.
    supa.setTable(
      "run_sequence",
      ok([{ event_name: "A Lot Of Tone Fest", event_date: "2026-08-09" }])
    );
    const tree = await OverviewPage();
    const board = findEl(tree, OverviewClient);
    expect(board!.props!.runOrderFestivals).toEqual(["A Lot Of Tone Fest__2026-08-09"]);
  });

  it("does not flag a complete show as incomplete when the child reads are empty", async () => {
    // The false "⚠ ขาด N" this whole area exists to prevent has an inverse worth
    // pinning: an empty setlist for a real show is still reported honestly.
    const tree = await OverviewPage();
    const board = findEl(tree, OverviewClient);
    const events = board!.props!.events as { incomplete: number; copyrightPending: number }[];
    expect(events.every((e) => typeof e.incomplete === "number")).toBe(true);
    expect(events.every((e) => e.copyrightPending === 0)).toBe(true);
  });
});
