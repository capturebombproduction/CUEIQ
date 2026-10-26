import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { WorkspaceData } from "~/data/workspace";

// 2026-10-27 (hunt 6): the page tells EventWorkspace when the bundle on screen is this
// device's stored copy rather than a server read.
//
// Every router.refresh() (บันทึก / อัปเดต, the Summary tab, the auto status write) is a
// re-read of the bundle here, and with no server to reach it is served from the
// read-cache: the last ONLINE read, older than an edit saved online since. Passed on as
// if it were a server read, it re-seeded a tab that was waiting for one - the edit came
// back as the cached value and its next blur wrote that over the newer one. A first
// load offline still renders from the cache, as before; it is simply marked.

const h = vi.hoisted(() => ({
  load: { bundle: null as unknown, unreachable: false },
  reload: null as unknown,
  ws: null as unknown,
  supa: null as unknown,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/event-bundle", () => ({
  loadEventBundleStatus: vi.fn(() => Promise.resolve(h.load)),
  loadEventBundle: vi.fn(() => Promise.resolve(h.reload)),
}));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/event/event-workspace", async () => {
  const { useRouter } = await import("next/navigation");
  return {
    EventWorkspace: (p: { cachedCopy?: boolean; schedule: { label: string }[] }) => {
      const router = useRouter();
      return (
        <button
          data-testid="workspace"
          data-cached={String(p.cachedCopy === true)}
          data-label={p.schedule[0]?.label ?? ""}
          onClick={() => router.refresh()}
        />
      );
    },
  };
});
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventPage } from "./event";

const EVENT_ID = "ev-1";

function bundle(label: string, fromCache?: true) {
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
      status: "draft",
      notes: null,
      share_token: null,
      share_expires_at: null,
      group: { id: "g1", tenant_id: "t1", name: "Seishin Kakumei", skin: null },
    },
    schedule: [{ id: "s1", kind: "stage", label, start_time: "19:00:00", sort_order: 1 }],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
    role: null,
    ...(fromCache ? { fromCache } : {}),
  };
}

const perms = makePerms("admin");
const ADMIN: WorkspaceData = {
  user: { id: "u1", email: "u@cueiq.local", name: "U" },
  membership: { tenant_id: "t1", role: "admin" },
  tenant: { id: "t1", name: "A Lot Of Tone" } as never,
  groups: [],
  groupRoles: [],
  perms,
};

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
  h.supa = makeSupabaseFake({ script: { run_sequence: ok([]) } });
});

describe("desktop EventPage · a bundle served from the read-cache", () => {
  it("a first load offline still renders the show from the cache - marked as the stored copy", async () => {
    h.load = { bundle: bundle("B", true), unreachable: true };
    renderPage();
    const ws = await screen.findByTestId("workspace");
    expect(ws.getAttribute("data-label")).toBe("B");
    expect(ws.getAttribute("data-cached")).toBe("true");
  });

  it("a re-read served from the cache is marked; the next server read is not", async () => {
    h.load = { bundle: bundle("B"), unreachable: false };
    renderPage();
    const ws = await screen.findByTestId("workspace");
    expect(ws.getAttribute("data-cached")).toBe("false");

    h.reload = bundle("B", true); // บันทึก / อัปเดต with the venue wifi gone
    fireEvent.click(ws);
    await waitFor(() => expect(screen.getByTestId("workspace").getAttribute("data-cached")).toBe("true"));

    h.reload = bundle("C"); // back online
    fireEvent.click(screen.getByTestId("workspace"));
    await waitFor(() => expect(screen.getByTestId("workspace").getAttribute("data-label")).toBe("C"));
    expect(screen.getByTestId("workspace").getAttribute("data-cached")).toBe("false");
  });
});
