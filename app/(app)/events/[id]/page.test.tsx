import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import EventPage from "@/app/(app)/events/[id]/page";
import { EventWorkspace } from "@/components/event/event-workspace";
import { EventHero } from "@/components/event/event-hero";
import { EventCopyrightPanel } from "@/components/event/event-copyright-panel";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";

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

// The header's time, 2026-10-01: "18:00 น." alone read as the call time to the
// members who open this page to find out when to be there (lib/next-show.ts).
describe("EventPage — the header says when to be there", () => {
  function textOf(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    const el = node as Elementish;
    return el.props ? textOf(el.props.children) : "";
  }

  it("names the call time from the show's own schedule, and the stage time", async () => {
    (h.bundle as { schedule: unknown[] }).schedule = [
      { id: "s2", event_id: EVENT_ID, kind: "stage", start_time: "18:00:00" },
      { id: "s1", event_id: EVENT_ID, kind: "on_location", start_time: "16:00:00" },
    ];
    expect(textOf(await call())).toContain("นัด 16:00 · ขึ้นเวที 18:00");
  });

  it("with no schedule yet, still says what the one time is", async () => {
    const text = textOf(await call());
    expect(text).toContain("ขึ้นเวที 18:00");
    expect(text).not.toContain("นัด");
  });
});

// The hero's practice button (spec G.3) shows for a band member before the show
// day. It said "ซ้อมตามเซ็ต" — the dashboard ticket's words for the band's practice
// ROOM — but always opened the Training list, because nothing passed it a room.
// Same words, two places. The room is now found the ticket's way.
describe("EventPage — the practice button opens the band's room", () => {
  const asMemberBeforeTheShow = () => {
    (h.ws as { perms: unknown }).perms = makePerms("member", [
      { group_id: "g1", role: "member" } as never,
    ]);
    (h.bundle as { event: { event_date: string } }).event.event_date = "2099-12-01";
  };
  /** Render the hero the page built, and return its practice link. */
  const practiceLink = async () => {
    const hero = findEl(await call(), EventHero);
    expect(hero).not.toBeNull();
    render(
      <EventHero {...(hero!.props as ComponentProps<typeof EventHero>)} statusActions={null} more={null} />
    );
    return screen.getByRole("link", { name: /ซ้อม/ });
  };

  it("for a member before the show day: the room the band last practised in", async () => {
    asMemberBeforeTheShow();
    supa.setTable(
      "events",
      ok([
        { id: "room-new", group_id: "g1" },
        { id: "room-used", group_id: "g1" },
      ])
    );
    supa.setTable("practice_runs", ok([{ event_id: "room-used", group_id: "g1" }]));
    const link = await practiceLink();
    expect(link).toHaveAttribute("href", "/events/room-used/practice");
    expect(link).toHaveTextContent("ซ้อมตามเซ็ต");
  });

  it("a failed room read does not fail the page: it opens the Training list, labelled ห้องซ้อม", async () => {
    asMemberBeforeTheShow();
    supa.setTable("events", fail("boom-rooms", 500));
    supa.setTable("practice_runs", ok([]));
    const link = await practiceLink();
    expect(link).toHaveAttribute("href", "/practice");
    expect(link).toHaveTextContent("ห้องซ้อม");
    expect(link).not.toHaveTextContent("ซ้อมตามเซ็ต");
  });

  it("asks nothing extra when Live Mode leads (an admin)", async () => {
    await call();
    expect(supa.calls.map((c) => c.table)).not.toContain("practice_runs");
  });
});

// Spec G.3: the approvers' copyright triage belongs to the Summary. Rendered here
// between the hero and the workspace, its one row per song pushed the tabs off a
// phone's first screen (~800 px for twelve songs).
describe("EventPage — copyright triage sits under the run sheet", () => {
  it("hands the panel to the workspace's Summary instead of stacking it above the tabs", async () => {
    const b = h.bundle as { setlist: unknown[]; songs: unknown[] };
    b.setlist = [{ id: "i1", song_id: "s1", sort_order: 1 }];
    b.songs = [{ id: "s1", title: "Akai Hana", copyright_status: "pending" }];
    const tree = await call();
    expect(findEl(tree, EventCopyrightPanel)).toBeNull();
    const footer = findEl(tree, EventWorkspace)!.props!.summaryFooter as Elementish;
    expect(footer?.type).toBe(EventCopyrightPanel);
    expect(footer.props!.songs).toEqual([{ id: "s1", title: "Akai Hana", copyright_status: "pending" }]);
  });

  it("gives a member no panel at all", async () => {
    (h.ws as { perms: unknown }).perms = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
    const b = h.bundle as { setlist: unknown[]; songs: unknown[] };
    b.setlist = [{ id: "i1", song_id: "s1", sort_order: 1 }];
    b.songs = [{ id: "s1", title: "Akai Hana", copyright_status: "pending" }];
    supa.setTable("events", ok([]));
    supa.setTable("practice_runs", ok([]));
    const tree = await call();
    expect(findEl(tree, EventWorkspace)!.props!.summaryFooter ?? null).toBeNull();
  });
});
