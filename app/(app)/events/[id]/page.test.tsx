import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import EventPage from "@/app/(app)/events/[id]/page";
import { EventWorkspace } from "@/components/event/event-workspace";

// getEventBundle is already all-or-none about its six child reads — it throws
// rather than hand the page five good lists and one silently-emptied one. This
// page then issues a SEVENTH read of its own, for the festival running order, and
// left it outside that rule: `runSeqData ?? []` tells a band's own event page
// "วงนี้ยังไม่ถูกผูกกับลำดับในคิวงาน" and drops the countdown its members are
// watching, because one select timed out on festival day.
const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown, bundle: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));
vi.mock("@/lib/queries", () => ({
  getWorkspace: async () => h.ws,
  getEventBundle: async () => h.bundle,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/event/event-workspace", () => ({ EventWorkspace: () => null }));

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
const call = () => EventPage({ params: Promise.resolve({ id: EVENT_ID }) });

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({ script: { run_sequence: ok([]) } });
  h.supa = supa;
  h.bundle = {
    event: {
      id: EVENT_ID,
      tenant_id: "t1",
      group_id: "g1",
      name: "A Lot Of Tone Fest",
      event_date: "2026-08-09",
      venue: "Bangkok",
      event_type: "idol",
      show_start_time: "18:00:00",
      hard_out_time: null,
      status: "approved",
      notes: null,
      deadline: null,
      deadline_note: null,
      is_template: false,
      is_practice: false,
      group: { id: "g1", name: "Seishin Kakumei", color: "#A62A1C", skin: null },
    },
    schedule: [],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
  };
  h.ws = {
    user: { id: "u1", email: "admin@cueiq.local", name: "Admin" },
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

describe("EventPage — a failed read is not a zero count", () => {
  it("throws instead of reporting the band as unscheduled when run_sequence fails", async () => {
    supa.setTable("run_sequence", fail("boom-run_sequence", 500));
    await expect(call()).rejects.toMatchObject({
      name: "ReadFailedError",
      message: expect.stringContaining("boom-run_sequence") as unknown as string,
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("covers every table the page reads itself — a second read must fail this test", async () => {
    // Everything else on this page comes through getEventBundle, which owns its
    // own all-or-none guard. If a read is ever added here directly, it needs an
    // entry in the guard, and this is where that is noticed.
    await call();
    expect(Array.from(new Set(supa.calls.map((c) => c.table)))).toEqual(["run_sequence"]);
  });
});

describe("EventPage — an empty read is still an empty order", () => {
  it("renders a show that is genuinely not in any running order", async () => {
    const tree = await call();
    const ws = findEl(tree, EventWorkspace);
    expect(ws).not.toBeNull();
    expect(ws!.props!.runSeq).toEqual([]);
    // The bundle's own genuinely-empty children are still empty, not an error.
    expect(ws!.props!.setlist).toEqual([]);
  });

  it("passes the running order through when the festival has one", async () => {
    const rows = [{ id: "r1", sort_order: 1, linked_event_id: EVENT_ID }];
    supa.setTable("run_sequence", ok(rows));
    const tree = await call();
    expect(findEl(tree, EventWorkspace)!.props!.runSeq).toEqual(rows);
  });

  it("still 404s a genuinely missing event", async () => {
    h.bundle = null;
    await expect(call()).rejects.toThrow("NEXT_NOT_FOUND");
    // …and never reaches the running-order read.
    expect(supa.calls).toHaveLength(0);
  });

  it("still 404s an event outside the user's band scope", async () => {
    (h.ws as { perms: unknown }).perms = makePerms("member", [
      { group_id: "other-band", role: "member" },
    ]);
    await expect(call()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(supa.calls).toHaveLength(0);
  });
});
