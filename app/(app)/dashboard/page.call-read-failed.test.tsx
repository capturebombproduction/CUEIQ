// Hunt 3 (2026-10-27), overview-2. The web dashboard reads every upcoming show's schedule for
// the ticket's "นัด" cell best-effort, but a FAILED read is folded into `callTimes = {}` -
// which EventsList's own contract reads as "the schedules were read and this show has NO
// call time" and prints "นัด —". A failed read must be `undefined` (unknown: cell left out),
// the same answer the desktop gives when it has no bundle.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake, ok, fail } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/event/events-list", () => ({ EventsList: () => null }));
vi.mock("@/components/whats-new", () => ({ WhatsNew: () => null }));
vi.mock("@/components/join-demo", () => ({ JoinDemo: () => null }));

import DashboardPage from "@/app/(app)/dashboard/page";
import { EventsList } from "@/components/event/events-list";

interface El { type?: unknown; props?: Record<string, unknown> }
function findEl(node: unknown, type: unknown): El | null {
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findEl(c, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as El;
  if (el.type === type) return el;
  return el.props ? findEl(el.props.children, type) : null;
}

const GROUP = { id: "g1", tenant_id: "t1", name: "Seishin Kakumei", color: null, exempt_from_deadline: false,
  self_photo: false, contact_name: null, contact_phone: null, skin: null };

beforeEach(() => {
  h.supa = makeSupabaseFake({
    script: {
      events: ok([{ id: "e1", tenant_id: "t1", group_id: "g1", name: "Show", event_date: "2099-01-01",
        show_start_time: "13:20:00", status: "approved", is_template: false, is_practice: false,
        groups: { name: "Seishin Kakumei", color: null, exempt_from_deadline: false } }]),
      schedule_items: fail("statement timeout", 500),
      practice_runs: ok([]),
    },
  });
  h.ws = {
    user: { id: "u1", email: "m@cueiq.local", name: "M" },
    membership: { tenant_id: "t1", role: "member" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [GROUP],
    groupRoles: [{ group_id: "g1", role: "member" }],
    perms: makePerms("member", [{ group_id: "g1", role: "member" }]),
  };
});

describe("dashboard call times after a FAILED schedule read", () => {
  it("passes callTimes as unknown (undefined), not as 'read, and there is none' ({})", async () => {
    const tree = await DashboardPage();
    const list = findEl(tree, EventsList);
    expect(list).not.toBeNull();
    expect(list!.props!.callTimes).toBeUndefined();
  });
});
