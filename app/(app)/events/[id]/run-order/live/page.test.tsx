import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok, fail, anonEmpty, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import RunOrderLivePage from "@/app/(app)/events/[id]/run-order/live/page";
import { EventLiveCaller } from "@/components/event/event-live-caller";

// The live show-caller. /api/notify sends ~19 phones to this exact route within
// seconds of each other when staff press เริ่ม, so the read below is taken 19 times
// on venue wifi. The event read was already hardened (getEventRow throws rather
// than claiming the show does not exist); the running-order read next to it was
// still `const { data: seqs } = await rq`, which shows the one phone that drew a
// hiccup a blank board for a festival that is running in front of it.
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
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/event/event-live-caller", () => ({ EventLiveCaller: () => null }));

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
  RunOrderLivePage({
    params: Promise.resolve({ id: EVENT_ID }),
    searchParams: Promise.resolve({ from: "overview" }),
  });

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({ script: { run_sequence: ok([]) } });
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

describe("RunOrderLivePage — a failed read is not a zero count", () => {
  it("throws instead of opening a blank board when run_sequence fails", async () => {
    supa.setTable("run_sequence", fail("boom-run_sequence", 500));
    await expect(call()).rejects.toMatchObject({
      name: "ReadFailedError",
      message: expect.stringContaining("boom-run_sequence") as unknown as string,
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("throws on a transport failure too (status 0 — the venue wifi drop)", async () => {
    supa.setTable("run_sequence", { data: null, error: { message: "Failed to fetch" }, status: 0 });
    await expect(call()).rejects.toMatchObject({ name: "ReadFailedError" });
  });

  it("covers every table the page reads — a second read must fail this test", async () => {
    await call();
    expect(Array.from(new Set(supa.calls.map((c) => c.table)))).toEqual(["run_sequence"]);
  });
});

describe("RunOrderLivePage — an empty read is still an empty order", () => {
  it("opens with an empty caller when the order genuinely has no rows", async () => {
    const tree = await call();
    const caller = findEl(tree, EventLiveCaller);
    expect(caller).not.toBeNull();
    expect(caller!.props!.initial).toEqual([]);
    expect(caller!.props!.canControl).toBe(true);
  });

  it("accepts the RLS-as-anon empty answer rather than crashing the show", async () => {
    // A deliberate limit of the server half. `{ data: [], error: null }` is what
    // RLS answers an unsigned request with, and it is indistinguishable from an
    // empty table HERE — there is no previous board to keep and no session to
    // interrogate mid-render. The client board is where that case is caught
    // (keepOnUntrustedEmpty / EventRunStatusCard). Pinned so the difference is a
    // decision, not an oversight: this page must render, not throw.
    supa.setTable("run_sequence", anonEmpty());
    const tree = await call();
    expect(findEl(tree, EventLiveCaller)!.props!.initial).toEqual([]);
  });

  it("passes the running order through when it exists", async () => {
    const rows = [{ id: "r1", sort_order: 1, kind: "band" }];
    supa.setTable("run_sequence", ok(rows));
    const tree = await call();
    expect(findEl(tree, EventLiveCaller)!.props!.initial).toEqual(rows);
  });

  it("still shows the 404 for a genuinely missing event", async () => {
    // getEventRow's own contract, unchanged by this round: null = really gone.
    h.ev = null;
    await expect(call()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
