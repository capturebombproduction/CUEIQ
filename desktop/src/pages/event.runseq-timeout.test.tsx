import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import type { WorkspaceData } from "~/data/workspace";

// 2026-10-27 (hunt 7): the band's live-queue card on the event page reads the festival's
// run_sequence, and keeps the last answer on disk for the venue. The read had no deadline:
// on wifi that is joined but answers nothing (navigator.onLine true, so not "offline"), it
// never settled, the cached fallback never ran, and the card stayed away for good with its
// order sitting right there in the read-cache. Bounded like the event read now.

const h = vi.hoisted(() => ({ ws: null as unknown }));

/** A query that never answers - every builder call returns itself, `then` never settles. */
function blackHole(): unknown {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "in", "limit"]) q[m] = () => q;
  q.then = () => new Promise(() => {});
  return q;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => blackHole() }) }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: () => new Promise(() => {}) }));
vi.mock("~/data/event-bundle", () => ({
  loadEventBundleStatus: vi.fn(() => Promise.resolve({ bundle: bundle(), unreachable: false })),
  loadEventBundle: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/event/event-workspace", () => ({
  EventWorkspace: (p: { runSeq?: unknown[] }) => (
    <div data-testid="workspace" data-runseq={String(p.runSeq?.length ?? 0)} />
  ),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventPage, RUNSEQ_CARD_TIMEOUT_MS } from "./event";

const EVENT_ID = "ev-1";

function bundle() {
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
    schedule: [],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
    role: null,
  };
}

const ADMIN: WorkspaceData = {
  user: { id: "u1", email: "u@cueiq.local", name: "U" },
  membership: { tenant_id: "t1", role: "admin" },
  tenant: { id: "t1", name: "A Lot Of Tone" } as never,
  groups: [],
  groupRoles: [],
  perms: makePerms("admin"),
};

beforeEach(() => {
  h.ws = ADMIN;
  localStorage.clear();
  localStorage.setItem(
    `cueiq:cache:runseq:${EVENT_ID}`,
    JSON.stringify([{ id: "r1", band_name: "Seishin Kakumei", sort_order: 1 }])
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("desktop EventPage · the live-queue card on a network that never answers", () => {
  it("shows the cached running order once the read has waited its budget", async () => {
    render(
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <Routes>
          <Route path="/events/:id" element={<EventPage />} />
        </Routes>
      </MemoryRouter>
    );
    const ws = await screen.findByTestId("workspace");
    expect(ws.getAttribute("data-runseq")).toBe("0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNSEQ_CARD_TIMEOUT_MS + 100);
    });
    expect(screen.getByTestId("workspace").getAttribute("data-runseq")).toBe("1");
  });
});
