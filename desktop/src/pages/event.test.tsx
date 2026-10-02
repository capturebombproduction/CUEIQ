import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { skinCss } from "@/lib/skin";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { WorkspaceData } from "~/data/workspace";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP EVENT PAGE, against the web one (app/(app)/events/[id]/page.tsx).
//
// It is a client-fetched mirror of that server page, and the mirror had drifted in
// three places this file pins: the band's skin (the web page wears the band's colour,
// the .exe showed every band in the device's own), the อนุมัติ / ปฏิเสธ button an
// approver needs when the daily reminder drops them on a waiting show, and the Quick
// Show door on the "could not reach the server" screen (one copy of the markup now,
// ~/components/quick-show-link.tsx). EventWorkspace is mocked — its own tests cover it.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  load: { bundle: null as unknown, unreachable: false },
  ws: null as unknown,
  supa: null as unknown,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/event-bundle", () => ({
  loadEventBundleStatus: vi.fn(() => Promise.resolve(h.load)),
  loadEventBundle: vi.fn(() => Promise.resolve(h.load.bundle)),
}));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/event/event-workspace", () => ({
  EventWorkspace: () => <div data-testid="workspace" />,
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventPage } from "./event";
import { loadEventBundle } from "~/data/event-bundle";

const EVENT_ID = "ev-1";

function bundle(over: { skin?: string | null; status?: string; group?: null } = {}) {
  const group =
    over.group === null
      ? null
      : { id: "g1", tenant_id: "t1", name: "Seishin Kakumei", skin: over.skin ?? null };
  return {
    event: {
      id: EVENT_ID,
      tenant_id: "t1",
      group_id: "g1",
      name: "A Lot Of Tone Fest",
      event_date: "2026-10-10",
      venue: "Moonstar Studio",
      event_type: "festival",
      show_start_time: "19:00:00",
      hard_out_time: null,
      status: over.status ?? "draft",
      notes: null,
      share_token: null,
      share_expires_at: null,
      group,
    },
    schedule: [],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
    role: null,
  };
}

const wsOf = (perms: ReturnType<typeof makePerms>): WorkspaceData => ({
  user: { id: "u1", email: "u@cueiq.local", name: "U" },
  membership: { tenant_id: "t1", role: perms.tenantRole ?? "member" },
  tenant: { id: "t1", name: "A Lot Of Tone" } as never,
  groups: [],
  groupRoles: [],
  perms,
});
const ADMIN = wsOf(makePerms("admin"));
const BAND_AR = wsOf(makePerms("member", [{ group_id: "g1", role: "ar" } as never]));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
      <Routes>
        <Route path="/events/:id" element={<EventPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  h.ws = ADMIN;
  h.load = { bundle: bundle(), unreachable: false };
  h.supa = makeSupabaseFake({
    script: { run_sequence: ok([]), events: ok([{ id: EVENT_ID }]) },
  });
  vi.mocked(loadEventBundle).mockClear();
});

describe("desktop EventPage — the band's skin", () => {
  it("wears the show's band colour, as the web page does — the page's FIRST child", async () => {
    h.load = { bundle: bundle({ skin: "#a62a1c" }), unreachable: false };
    const { container } = renderPage();
    await screen.findByTestId("workspace");
    const skin = document.getElementById("cueiq-band-skin");
    expect(skin).not.toBeNull();
    expect(skin!.textContent).toBe(skinCss("#a62a1c"));
    expect(container.firstElementChild!.firstElementChild).toBe(skin);
  });

  it.each([
    ["a band with no colour", { skin: null }],
    ["a show whose band row did not come back", { group: null }],
  ])("adds no skin for %s", async (_label, over) => {
    h.load = { bundle: bundle(over), unreachable: false };
    renderPage();
    await screen.findByTestId("workspace");
    expect(document.getElementById("cueiq-band-skin")).toBeNull();
  });
});

describe("desktop EventPage — อนุมัติ / ปฏิเสธ for an approver", () => {
  const approve = () => screen.queryByRole("button", { name: /อนุมัติ \/ ปฏิเสธ/ });

  it("shows the button to an approver on a show that is waiting for one", async () => {
    h.load = { bundle: bundle({ status: "pending_review" }), unreachable: false };
    renderPage();
    await screen.findByTestId("workspace");
    expect(approve()).not.toBeNull();
  });

  it("does not show it to someone who cannot approve", async () => {
    h.ws = BAND_AR;
    h.load = { bundle: bundle({ status: "pending_review" }), unreachable: false };
    renderPage();
    await screen.findByTestId("workspace");
    expect(approve()).toBeNull();
  });

  it.each(["draft", "approved", "rejected"])(
    "does not show it on a %s show — there is nothing to approve",
    async (status) => {
      h.load = { bundle: bundle({ status }), unreachable: false };
      renderPage();
      await screen.findByTestId("workspace");
      expect(approve()).toBeNull();
    }
  );

  it("approving writes the status and re-reads the bundle through the router.refresh shim", async () => {
    h.load = { bundle: bundle({ status: "pending_review" }), unreachable: false };
    renderPage();
    await screen.findByTestId("workspace");
    expect(loadEventBundle).not.toHaveBeenCalled();

    fireEvent.click(approve()!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^อนุมัติ$/ }));

    await waitFor(() => expect(loadEventBundle).toHaveBeenCalledWith(EVENT_ID));
    const write = (h.supa as ReturnType<typeof makeSupabaseFake>).lastCall("events", "update");
    expect(write?.values).toEqual({ status: "approved" });
    expect(write?.eq).toEqual({ id: EVENT_ID });
  });
});

describe("desktop EventPage — when the server could not be reached", () => {
  it("offers a retry and the shared Quick Show door, not a dead end", async () => {
    h.load = { bundle: null, unreachable: true };
    renderPage();
    const door = await screen.findByTestId("quick-show-link");
    expect(door.getAttribute("href")).toBe("/my-show");
    expect(screen.getByRole("button", { name: "ลองใหม่" })).toBeTruthy();
  });
});
