// THE DESKTOP DASHBOARD — the two things it was missing next to the web's.
//
// CQ-68 (dashboard half): "สร้างจากแม่แบบ". The web dashboard reads each band's own
// demo-draft template in its server query and shows the button beside "New Event";
// the desktop page never fetched templates, so an Ar who clones a show from the
// template on the web had no way to on the desktop.
//
// CQ-65: the Next Show ticket's "นัด". The desktop's events list is an offline cache
// without schedules, so the ticket printed "นัด —" for every show. It now reads the
// call time out of the bundles already on the device, and leaves the cell out when it
// has none to read from.
//
// The list itself (EventsList) is the REAL component — the point is the wiring from
// this page into it, and a mock there would test nothing. What is doubled is the
// network (the supabase fake), the list loader and the workspace context.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { fail, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import type { Group } from "@/lib/types";
import type { WorkspaceData } from "~/data/workspace";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  ws: null as unknown,
  events: [] as unknown[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("~/data/events-list", () => ({
  loadEventsList: vi.fn(() => Promise.resolve(h.events)),
}));
vi.mock("~/data/song-library", () => ({ warmSongLibrary: vi.fn() }));
vi.mock("@/components/whats-new", () => ({ WhatsNew: () => null }));

import { Dashboard } from "./dashboard";

const TENANT = "tenant-a";
const group = (id: string, name: string): Group => ({
  id,
  tenant_id: TENANT,
  name,
  color: null,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z",
});
const G1 = group("g1", "Seishin Kakumei");
const G2 = group("g2", "Another Band");

const workspace = (
  tenantRole: WorkspaceData["perms"]["tenantRole"],
  groupRoles: WorkspaceData["groupRoles"] = [],
  groups: Group[] = [G1, G2]
): WorkspaceData => ({
  user: { id: "u1", email: "u@cueiq.local", name: "พี่พัชร์" },
  membership: { tenant_id: TENANT, role: tenantRole ?? "member" },
  tenant: { id: TENANT, name: "A Lot Of Tone" } as WorkspaceData["tenant"],
  groups,
  groupRoles,
  perms: makePerms(tenantRole, groupRoles),
});

const TEMPLATE_BUTTON = { name: /สร้างจากแม่แบบ/ };

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <ConfirmProvider>
        <Dashboard />
      </ConfirmProvider>
    </MemoryRouter>
  );

/** A macrotask later: every .then of an already-answered read has run and React has
 *  flushed what it set. "Nothing appeared" is only worth asserting after this. */
const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
/** The template read has gone out AND its answer has been handled. */
const readHandled = async () => {
  await vi.waitFor(() => expect(supa.callsTo("events", "select")).toHaveLength(1));
  await flush();
};

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      events: ok([
        { id: "tpl-1", group_id: "g1" },
        { id: "tpl-2", group_id: "g2" },
      ]),
    },
  });
  h.supa = supa;
  h.ws = workspace("admin");
  h.events = [];
});

describe("desktop Dashboard — สร้างจากแม่แบบ (CQ-68, dashboard half)", () => {
  it("an admin gets the button beside New Event, fed by the bands' own templates", async () => {
    mount();
    expect(await screen.findByRole("button", TEMPLATE_BUTTON)).toBeTruthy();
    expect(screen.getByRole("link", { name: /New Event/ })).toBeTruthy();
    // it asked for THIS label's templates, and only templates
    const call = supa.callsTo("events", "select")[0];
    expect(call.eq).toMatchObject({ tenant_id: TENANT, is_template: true });
  });

  it("an Ar gets it for the band they manage — and only when that band has a template", async () => {
    h.ws = workspace("member", [{ group_id: "g1", role: "artist_manager" }], [G1]);
    mount();
    expect(await screen.findByRole("button", TEMPLATE_BUTTON)).toBeTruthy();
  });

  it("an Ar whose band has no template of its own is not offered another band's", async () => {
    h.ws = workspace("member", [{ group_id: "g1", role: "artist_manager" }], [G1]);
    supa.setTable("events", ok([{ id: "tpl-2", group_id: "g2" }]));
    mount();
    // wait for the read to have happened and been handled, then see that nothing appeared
    await readHandled();
    expect(supa.callsTo("events", "select")).toHaveLength(1);
    expect(screen.queryByRole("button", TEMPLATE_BUTTON)).toBeNull();
    // New Event is still theirs
    expect(screen.getByRole("link", { name: /New Event/ })).toBeTruthy();
  });

  it("a member, who cannot create, neither sees it nor makes the read", async () => {
    h.ws = workspace("member", [{ group_id: "g1", role: "member" }], [G1]);
    mount();
    await flush();
    expect(screen.queryByRole("button", TEMPLATE_BUTTON)).toBeNull();
    expect(screen.queryByRole("link", { name: /New Event/ })).toBeNull();
    expect(supa.callsTo("events")).toHaveLength(0);
  });

  it("offline it makes no request at all — the clone writes straight to Supabase", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      mount();
      await flush();
      expect(supa.callsTo("events")).toHaveLength(0);
      expect(screen.queryByRole("button", TEMPLATE_BUTTON)).toBeNull();
      // the rest of the header is untouched
      expect(screen.getByRole("link", { name: /New Event/ })).toBeTruthy();
    } finally {
      Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("a failed template read leaves the button out and the page standing", async () => {
    supa.setTable("events", fail("Failed to fetch"));
    mount();
    await readHandled();
    expect(screen.queryByRole("button", TEMPLATE_BUTTON)).toBeNull();
    expect(screen.getByRole("link", { name: /New Event/ })).toBeTruthy();
  });

  it("a template read that rejects is swallowed too (no unhandled rejection)", async () => {
    supa.setTable("events", () => Promise.reject(new Error("socket hang up")));
    mount();
    await readHandled();
    expect(screen.queryByRole("button", TEMPLATE_BUTTON)).toBeNull();
    expect(screen.getByRole("link", { name: /New Event/ })).toBeTruthy();
  });
});

describe("desktop Dashboard — the Next Show ticket's นัด (CQ-65)", () => {
  // Dates relative to a pinned today (Bangkok 2026-10-02) so "upcoming" is stable.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T05:00:00Z"));
    h.ws = workspace("member", [{ group_id: "g1", role: "member" }], [G1]);
    h.events = [
      {
        id: "up",
        tenant_id: TENANT,
        group_id: "g1",
        name: "Welcome to friendverse",
        event_date: "2026-10-03",
        venue: null,
        event_type: "idol",
        show_start_time: "19:00:00",
        hard_out_time: null,
        status: "approved",
        deadline: null,
        last_run_seconds: null,
        is_template: false,
        is_practice: false,
        created_at: "2026-01-01T00:00:00.000Z",
        groups: { name: "Seishin Kakumei", color: null, exempt_from_deadline: false },
      },
    ];
  });
  afterEach(() => vi.useRealTimers());

  const ticket = async () => within(await screen.findByRole("region", { name: "Next show" }));

  it("shows the call time read from the bundle this device already holds", async () => {
    window.localStorage.setItem(
      "cueiq:cache:event:up",
      JSON.stringify({
        event: { id: "up" },
        schedule: [
          { id: "s1", event_id: "up", kind: "on_location", start_time: "16:00:00" },
          { id: "s2", event_id: "up", kind: "stage", start_time: "19:00:00" },
        ],
      })
    );
    mount();
    const t = await ticket();
    expect(t.getByText("นัด").parentElement!.textContent).toBe("นัด16:00");
    expect(t.getByTestId("next-show-times").textContent).toBe("นัด 16:00 · ขึ้นเวที 19:00");
  });

  it("with no bundle on the device it leaves the cell out instead of printing นัด —", async () => {
    mount();
    const t = await ticket();
    expect(t.queryByText("นัด")).toBeNull();
    expect(t.getByTestId("next-show-times").textContent).toBe("ขึ้นเวที 19:00");
  });
});
