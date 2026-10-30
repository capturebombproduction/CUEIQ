// Which of a show's slots is its "first" - the one the board sorts and prints by. 2026-10-30,
// hunt 11: rangesOf ordered a show's rows of a kind down the clock string, so a 22:00 set
// with booth shifts at 23:00 and 00:30 had the 00:30 shift as its booth, and the 23:00 one
// as the "more". It now orders them round the show's own day (lib/day-order.ts, the event
// sheet's rule); a day that does not cross midnight keeps the plain clock order.
// desktop/src/pages/overview.tsx carries the same rangesOf.
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
  name: "Seishin Kakumei",
  color: "#A62A1C",
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  skin: null,
};

const show = (id: string, show_start_time: string) => ({
  id,
  tenant_id: "t1",
  group_id: "g1",
  name: `Show ${id}`,
  event_date: "2026-12-31",
  show_start_time,
  status: "draft",
  deadline: null,
  notes: null,
  is_template: false,
  is_practice: false,
});
const row = (id: string, event_id: string, kind: string, start_time: string, end_time: string, sort_order: number) => ({
  id,
  event_id,
  kind,
  label: null,
  start_time,
  end_time,
  sort_order,
});

beforeEach(() => {
  h.supa = makeSupabaseFake({
    script: {
      events: ok([show("late", "22:00:00"), show("day", "13:00:00")]),
      members: ok([]),
      songs: ok([]),
      staff_contacts: ok([]),
      schedule_items: ok([
        row("l-stage", "late", "stage", "22:00:00", "22:20:00", 1),
        row("l-booth-2", "late", "booth", "00:30:00", "01:00:00", 3),
        row("l-booth-1", "late", "booth", "23:00:00", "23:30:00", 2),
        row("d-stage-2", "day", "stage", "18:00:00", "18:20:00", 2),
        row("d-stage-1", "day", "stage", "13:00:00", "13:20:00", 1),
        row("d-booth-2", "day", "booth", "16:00:00", "16:30:00", 4),
        row("d-booth-1", "day", "booth", "14:00:00", "14:30:00", 3),
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

type Range = { start: string | null; end: string | null };
async function boardEvent(id: string) {
  const board = findEl(await OverviewPage(), OverviewClient);
  return (board!.props!.events as { id: string; booth: Range | null; boothMore?: Range[]; stage: Range | null; stageMore?: Range[] }[]).find(
    (e) => e.id === id
  )!;
}

describe("Overview - a show's first slot is the first one played", () => {
  it("a 22:00 set's booth is the 23:00 shift; the 00:30 one comes after it", async () => {
    const late = await boardEvent("late");
    expect(late.booth?.start).toBe("23:00:00");
    expect(late.boothMore?.map((r) => r.start)).toEqual(["00:30:00"]);
  });

  it("a daytime show keeps the plain clock order (stage 13:00 then 18:00, booth 14:00 then 16:00)", async () => {
    const day = await boardEvent("day");
    expect(day.stage?.start).toBe("13:00:00");
    expect(day.stageMore?.map((r) => r.start)).toEqual(["18:00:00"]);
    expect(day.booth?.start).toBe("14:00:00");
    expect(day.boothMore?.map((r) => r.start)).toEqual(["16:00:00"]);
  });
});
