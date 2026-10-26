// A show with TWO photo rounds (mig 0042: "ถ่ายรูป" + a named "รอบ 2"). The page used to
// pick ONE with find() over rows ordered by uuid: the board and the crew JPG showed a
// random round, and the inline photo editor (initialItemId) wrote into it - typing
// the main photo time could overwrite "รอบ 2". desktop/src/pages/overview.tsx shares
// lib/photo-rounds.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import OverviewPage from "@/app/(app)/overview/page";
import { OverviewClient } from "@/components/overview/overview-client";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/overview/overview-client", () => ({ OverviewClient: () => null }));
vi.mock("@/components/join-demo", () => ({ JoinDemo: () => null }));

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

const GROUP = {
  id: "g1",
  tenant_id: "t1",
  name: "HatoBito",
  color: "#EC4899",
  exempt_from_deadline: false,
  self_photo: false, // label staff fill the photo call from Overview
  contact_name: null,
  contact_phone: null,
  skin: null,
};

beforeEach(() => {
  h.supa = makeSupabaseFake({
    script: {
      events: ok([
        {
          id: "e1",
          tenant_id: "t1",
          group_id: "g1",
          name: "Two Costume Fest",
          event_date: "2026-11-02",
          status: "draft",
          deadline: null,
          notes: null,
          is_template: false,
          is_practice: false,
        },
      ]),
      members: ok([]),
      songs: ok([]),
      staff_contacts: ok([]),
      // As the page receives them: ordered by id. The named second round happens to
      // carry the smaller uuid.
      schedule_items: ok([
        { id: "0a-round-2", event_id: "e1", kind: "photo", label: "รอบ 2", start_time: "16:00:00", end_time: "16:15:00", sort_order: 5 },
        { id: "9f-main", event_id: "e1", kind: "photo", label: null, start_time: "13:00:00", end_time: "13:15:00", sort_order: 3 },
        { id: "5c-stage", event_id: "e1", kind: "stage", label: null, start_time: "14:00:00", end_time: "14:20:00", sort_order: 4 },
      ]),
      setlist_items: ok([]),
      run_sequence: ok([]),
      mic_assignments: ok([]),
      event_members: ok([]),
    },
  });
  h.ws = {
    user: { id: "u1", email: "label-staff@cueiq.local", name: "Staff" },
    membership: { tenant_id: "t1", role: "label_staff" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [GROUP],
    groupRoles: [],
    perms: makePerms("label_staff"),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("Overview — a show with two photo rounds", () => {
  it("the board carries BOTH photo calls (13:00 ถ่ายรูป and 16:00 รอบ 2), not one picked by uuid", async () => {
    const board = findEl(await OverviewPage(), OverviewClient);
    const e1 = (board!.props!.events as Record<string, unknown>[])[0];
    const dump = JSON.stringify(e1);
    expect(dump).toContain("13:00");
    expect(dump).toContain("16:00");
  });

  it("the inline photo editor targets the unnamed/ถ่ายรูป round, never overwrites รอบ 2", async () => {
    const board = findEl(await OverviewPage(), OverviewClient);
    const e1 = (board!.props!.events as { photoItemId: string | null; photo: string | null }[])[0];
    expect(e1.photoItemId).toBe("9f-main");
    expect(e1.photo).toBe("13:00:00");
  });
});
