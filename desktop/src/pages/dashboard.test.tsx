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
  news: [] as unknown[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("~/data/events-list", () => ({
  loadEventsList: vi.fn(() => Promise.resolve(h.events)),
}));
vi.mock("~/data/song-library", () => ({ warmSongLibrary: vi.fn() }));
// The card is a prop recorder (what the dashboard TELLS it is the subject, not how it
// renders); the rest of the module — readerFor, whatsNewItems — is the real one.
vi.mock("@/components/whats-new", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/whats-new")>()),
  WhatsNew: (props: unknown) => {
    h.news.push(props);
    return null;
  },
}));

import { Dashboard } from "./dashboard";
import { EVENT_BUNDLE_CACHED_EVENT, warmEventBundle } from "~/data/event-bundle";
import { whatsNewItems, type Reader } from "@/components/whats-new";

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
  h.news = [];
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

// CQ-38, desktop half. The web dashboard tells "มีอะไรใหม่" WHO is reading (a Reader),
// so an admin is never pointed at the banner's "ซ้อมตามเซ็ต" button (their second
// button is Live Mode) and label staff never at the Library or a practice room they do
// not have. The desktop page passed the bare `canEdit` and got the legacy reader that
// is told everything, so it said all of that to everyone.
describe("desktop Dashboard — What's New is told who is reading (CQ-38, desktop half)", () => {
  const PRACTICE_BUTTON = /ปุ่ม “ซ้อมตามเซ็ต”/;
  const LIBRARY = /^คลังเพลง:/;
  const BANNER_TIMES = /^หน้าแรก: บอก “นัด”/;
  const PRACTICE_ROOM = /^ห้องซ้อม:/;
  const SETLIST_EDITING = /ปุ่ม “เปลี่ยน”/;

  /** What the dashboard handed the card, and what that reader is told. */
  const told = async () => {
    mount();
    await vi.waitFor(() => expect(h.news.length).toBeGreaterThan(0));
    const props = h.news[h.news.length - 1] as { reader?: Reader; canEdit?: boolean };
    // the bare-canEdit shape is the one that falls back to "told everything"
    expect(props.reader, "WhatsNew got no reader: it would tell everyone everything").toBeDefined();
    return { reader: props.reader!, items: whatsNewItems(props.reader!) };
  };
  const mentions = (items: string[], re: RegExp) => items.some((t) => re.test(t));

  it("an admin: edits shows, has the Library — and is not pointed at a ซ้อม button they do not see", async () => {
    const { reader, items } = await told();
    expect(reader).toEqual({
      canEdit: true,
      canLibrary: true,
      canPractice: true,
      seesPracticeButton: false,
    });
    expect(mentions(items, PRACTICE_BUTTON)).toBe(false);
    expect(mentions(items, SETLIST_EDITING)).toBe(true);
    expect(mentions(items, LIBRARY)).toBe(true);
  });

  it("an Ar: edits their band's shows and DOES see the ซ้อมตามเซ็ต button", async () => {
    h.ws = workspace("member", [{ group_id: "g1", role: "artist_manager" }], [G1]);
    const { reader, items } = await told();
    expect(reader).toEqual({
      canEdit: true,
      canLibrary: true,
      canPractice: true,
      seesPracticeButton: true,
    });
    expect(mentions(items, PRACTICE_BUTTON)).toBe(true);
    expect(mentions(items, SETLIST_EDITING)).toBe(true);
  });

  it("a member: no editor-only items, and the ซ้อมตามเซ็ต button", async () => {
    h.ws = workspace("member", [{ group_id: "g1", role: "member" }], [G1]);
    const { reader, items } = await told();
    expect(reader).toEqual({
      canEdit: false,
      canLibrary: true,
      canPractice: true,
      seesPracticeButton: true,
    });
    expect(mentions(items, SETLIST_EDITING)).toBe(false);
    expect(mentions(items, PRACTICE_BUTTON)).toBe(true);
  });

  it("label staff: no Library, no banner, no practice room, no ซ้อม button", async () => {
    h.ws = workspace("label_staff");
    const { reader, items } = await told();
    expect(reader).toEqual({
      canEdit: false,
      canLibrary: false,
      canPractice: false,
      seesPracticeButton: false,
    });
    expect(mentions(items, LIBRARY)).toBe(false);
    expect(mentions(items, BANNER_TIMES)).toBe(false);
    expect(mentions(items, PRACTICE_BUTTON)).toBe(false);
    expect(mentions(items, PRACTICE_ROOM)).toBe(false);
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

  // ── the mixed cache ────────────────────────────────────────────────────────
  // The ticket is about the soonest show. A device that has only a LATER show's bundle
  // does not know the ticket's call time — and a map built from that later bundle used
  // to make the ticket say "นัด —", i.e. "there is none".

  const CALLED_AT = (id: string, call: string) =>
    window.localStorage.setItem(
      `cueiq:cache:event:${id}`,
      JSON.stringify({
        event: { id },
        schedule: [
          { id: "s1", event_id: id, kind: "on_location", start_time: call },
          { id: "s2", event_id: id, kind: "stage", start_time: "19:00:00" },
        ],
      })
    );
  /** The ticket's show (2026-10-03) plus one a week on. */
  const withLaterShow = () => {
    const up = h.events[0] as Record<string, unknown>;
    h.events = [up, { ...up, id: "later", name: "Later show", event_date: "2026-10-10" }];
  };

  it("when only a LATER show is cached, the ticket leaves นัด out — not 'นัด —'", async () => {
    withLaterShow();
    CALLED_AT("later", "14:00:00");
    mount();
    const t = await ticket();
    expect(t.queryByText("นัด")).toBeNull();
    expect(t.getByTestId("next-show-times").textContent).toBe("ขึ้นเวที 19:00");
  });

  it("once the ticket's OWN show is cached, its call time comes from its own bundle", async () => {
    withLaterShow();
    CALLED_AT("up", "16:00:00");
    CALLED_AT("later", "14:00:00");
    mount();
    const t = await ticket();
    expect(t.getByText("นัด").parentElement!.textContent).toBe("นัด16:00");
  });

  it("a cached ticket show with no call time of its own says — (read, and there is none)", async () => {
    withLaterShow();
    window.localStorage.setItem(
      "cueiq:cache:event:up",
      JSON.stringify({ event: { id: "up" }, schedule: [{ id: "s1", event_id: "up", kind: "stage", start_time: "19:00:00" }] })
    );
    CALLED_AT("later", "14:00:00");
    mount();
    const t = await ticket();
    expect(t.getByText("นัด").parentElement!.textContent).toBe("นัด—");
  });

  // ── the cache fills while the page is up ───────────────────────────────────

  it("a bundle that 'เตรียมทุกงาน' lands while the page is open reaches the ticket — no remount", async () => {
    // the real warm the dashboard's prepare-all calls through the bridge
    supa.setScript({
      events: ok([h.events[0]]),
      schedule_items: ok([
        { id: "s1", event_id: "up", kind: "on_location", start_time: "16:00:00" },
        { id: "s2", event_id: "up", kind: "stage", start_time: "19:00:00" },
      ]),
    });
    mount();
    expect((await ticket()).queryByText("นัด")).toBeNull();

    await act(async () => {
      expect(await warmEventBundle("up")).toBe(true);
    });

    const t = await ticket();
    expect(t.getByText("นัด").parentElement!.textContent).toBe("นัด16:00");
    expect(t.getByTestId("next-show-times").textContent).toBe("นัด 16:00 · ขึ้นเวที 19:00");
  });

  it("re-reads when a bundle is announced, and stops listening once the page is gone", async () => {
    const { unmount } = mount();
    expect((await ticket()).queryByText("นัด")).toBeNull();
    CALLED_AT("up", "16:00:00");
    act(() => {
      window.dispatchEvent(new Event(EVENT_BUNDLE_CACHED_EVENT));
    });
    expect((await ticket()).getByText("นัด").parentElement!.textContent).toBe("นัด16:00");

    const removed = vi.spyOn(window, "removeEventListener");
    try {
      unmount();
      expect(removed).toHaveBeenCalledWith(EVENT_BUNDLE_CACHED_EVENT, expect.any(Function));
      expect(removed).toHaveBeenCalledWith("online", expect.any(Function));
    } finally {
      removed.mockRestore();
    }
  });

  it("re-reads when the window comes back to the front, not when it is hidden", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      mount();
      expect((await ticket()).queryByText("นัด")).toBeNull();
      CALLED_AT("up", "16:00:00");

      visibility.mockReturnValue("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect((await ticket()).queryByText("นัด")).toBeNull();

      visibility.mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect((await ticket()).getByText("นัด").parentElement!.textContent).toBe("นัด16:00");
    } finally {
      visibility.mockRestore();
    }
  });

  it("re-reads when the network returns", async () => {
    mount();
    expect((await ticket()).queryByText("นัด")).toBeNull();
    CALLED_AT("up", "16:00:00");
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect((await ticket()).getByText("นัด").parentElement!.textContent).toBe("นัด16:00");
  });
});
