// The desktop practice room opens on a joined-but-dead network. Its bundle comes from
// loadEventBundle (bounded, falls back to the copy on disk); its own two reads - the
// song markers and the practice list - must be bounded too: on a venue/hotel wifi that
// is joined but black-holed (navigator.onLine TRUE, nothing answers) they never settle,
// and the room sat on "กำลังโหลดห้องซ้อม…" for good with everything it needs on disk.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown, bundle: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("~/data/event-bundle", () => ({ loadEventBundle: vi.fn(async () => h.bundle) }));
vi.mock("@/components/practice/practice-mode", () => ({
  PracticeMode: (p: { roomName: string }) => <p data-testid="practice-mode">{p.roomName}</p>,
}));

import { PracticeRoom } from "~/pages/practice";

let supa: SupabaseFake;

beforeEach(() => {
  vi.useFakeTimers();
  supa = makeSupabaseFake({ script: { practice_songs: ok([]) } });
  // the black-holed AP: the markers read goes out and nothing ever answers
  supa.defer("song_markers");
  h.supa = supa;
  h.ws = {
    user: { id: "u1", email: null, name: null },
    membership: { tenant_id: "t1", role: "member" },
    tenant: { id: "t1", name: "Label" },
    groups: [{ id: "g1", name: "Seishin" }],
    groupRoles: [{ group_id: "g1", role: "member" }],
    perms: makePerms("member", [{ group_id: "g1", role: "member" }]),
  };
  h.bundle = {
    event: { id: "room1", name: "ห้องซ้อม Seishin", group_id: "g1", tenant_id: "t1", is_practice: true },
    schedule: [],
    setlist: [],
    micMap: [],
    members: [],
    songs: [],
    lineup: [],
    role: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop practice room on a joined-but-dead network", () => {
  it("opens from the bundle on disk instead of loading for ever", async () => {
    render(
      <MemoryRouter initialEntries={["/events/room1/practice"]}>
        <Routes>
          <Route path="/events/:id/practice" element={<PracticeRoom />} />
        </Routes>
      </MemoryRouter>
    );
    // a full minute — far past every budget the other desktop loaders use (8 s / 20 s)
    for (let i = 0; i < 60; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(screen.queryByText("กำลังโหลดห้องซ้อม…")).toBeNull();
    expect(screen.getByTestId("practice-mode")).toBeInTheDocument();
    // …and says what it could not load, rather than showing an empty list as true
    expect(screen.getByText(/โหลดลิสต์ซ้อม\/มาร์กเกอร์ไม่สำเร็จ/)).toBeInTheDocument();
  });
});
