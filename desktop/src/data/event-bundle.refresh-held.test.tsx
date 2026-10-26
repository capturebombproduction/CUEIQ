// c4388cf made prepareAll re-read every bundle, but its button only shows while something
// is MISSING. A show whose files are all on this device and whose bundle is present
// counted as ready, so a set REORDERED / a song cut / a schedule changed on a phone since
// this laptop cached the show was never re-read, and Live opened last week's set at a
// no-wifi venue (2026-10-27 hunt). The dashboard now re-reads every held bundle itself.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makeSupabaseFake, ok, type RecordedCall, type SupabaseFake } from "@/test/fakes/supabase";
import type { Group } from "@/lib/types";
import type { WorkspaceData } from "~/data/workspace";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown, events: [] as unknown[] }));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("~/data/events-list", () => ({
  loadEventsList: vi.fn(() => Promise.resolve(h.events)),
}));
vi.mock("~/data/song-library", () => ({ warmSongLibrary: vi.fn() }));
// Every file of the CURRENT setlist is already on this device (same item ids: a reorder).
vi.mock("@/lib/audio-prefetch", () => ({
  getReadiness: vi.fn(async (_eventId: string, targets: unknown[]) => ({
    total: targets.length,
    ready: targets.length,
    stale: 0,
    missing: 0,
  })),
  prefetchEventAudio: vi.fn(async () => ({ totalTargets: 1, fetched: 0, skipped: 1, failed: 0, removedStale: 0 })),
}));

import { Dashboard } from "~/pages/dashboard";

const TENANT = "tenant-a";
const G1 = { id: "g1", tenant_id: TENANT, name: "Seishin Kakumei", color: null, skin: null,
  exempt_from_deadline: false, self_photo: false, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z" } as Group;
const SHOW = {
  id: "s1", tenant_id: TENANT, group_id: "g1", name: "Show", event_date: "2026-10-03", venue: null,
  event_type: "idol", show_start_time: "19:00:00", hard_out_time: null, status: "approved",
  deadline: null, last_run_seconds: null, is_template: false, is_practice: false,
  created_at: "2026-01-01T00:00:00.000Z",
  groups: { name: "Seishin Kakumei", color: null, exempt_from_deadline: false },
};
const item = (id: string, songId: string, sort: number) => ({
  id, event_id: "s1", song_id: songId, title: songId, sort_order: sort, audio_path: null, audio_name: null,
});
// server TODAY: B then A (reordered on a phone); the laptop cached A then B last week
const SERVER_ITEMS = [item("row-b", "song-b", 1), item("row-a", "song-a", 2)];
const CACHED_ITEMS = [item("row-a", "song-a", 1), item("row-b", "song-b", 2)];
const SONGS = [
  { id: "song-a", group_id: "g1", title: "A", audio_path: `${TENANT}/g1/a.wav`, audio_name: "a.wav" },
  { id: "song-b", group_id: "g1", title: "B", audio_path: `${TENANT}/g1/b.wav`, audio_name: "b.wav" },
];

function filtered<T extends Record<string, unknown>>(rows: T[], call: RecordedCall) {
  return rows.filter((r) =>
    call.filters.every((f) =>
      f.op === "eq" ? r[f.column] === f.value : f.op === "in" ? (f.value as unknown[]).includes(r[f.column]) : true
    )
  );
}

let supa: SupabaseFake;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T05:00:00Z"));
  supa = makeSupabaseFake({
    session: { access_token: "t", refresh_token: "r", user: { id: "u1" } } as never,
    script: {
      events: (c) => ok(filtered([SHOW], c)[0] ?? null),
      setlist_items: (c) => ok(filtered(SERVER_ITEMS, c)),
      songs: ok(SONGS),
      schedule_items: ok([]),
      mic_assignments: ok([]),
      members: ok([]),
      event_members: ok([]),
      tenant_members: ok([]),
    },
  });
  h.supa = supa;
  h.ws = {
    user: { id: "u1", email: "u@cueiq.local", name: "x" },
    membership: { tenant_id: TENANT, role: "member" },
    tenant: { id: TENANT, name: "A Lot Of Tone" },
    groups: [G1],
    groupRoles: [{ group_id: "g1", role: "member" }],
    perms: makePerms("member", [{ group_id: "g1", role: "member" }]),
  } as unknown as WorkspaceData;
  h.events = [SHOW];
  (window as unknown as { cueiqNative?: unknown }).cueiqNative = { isElectron: true };
  window.localStorage.setItem(
    "cueiq:cache:event:s1",
    JSON.stringify({ event: { ...SHOW, groups: undefined, group: G1 }, schedule: [], setlist: CACHED_ITEMS,
      micMap: [], members: [], songs: [], lineup: [], role: null })
  );
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
});

const onDisk = () =>
  (JSON.parse(window.localStorage.getItem("cueiq:cache:event:s1")!) as { setlist: { id: string }[] }).setlist.map(
    (r) => r.id
  );

describe("dashboard: every file cached, bundle stale (set reordered online)", () => {
  it("re-reads the bundle Live opens offline, once per window of time", async () => {
    const view = () =>
      render(
        <MemoryRouter initialEntries={["/"]}>
          <ConfirmProvider>
            <Dashboard />
          </ConfirmProvider>
        </MemoryRouter>
      );
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
      });
    const first = view();
    await settle();
    // readiness ran against the server's CURRENT setlist, found every file, offered nothing…
    expect(supa.calls.some((c) => c.table === "setlist_items")).toBe(true);
    expect(screen.queryByRole("button", { name: /เตรียมทุกงานที่จะถึง/ })).toBeNull();
    // …and still brought the held copy up to date
    expect(onDisk()).toEqual(["row-b", "row-a"]);

    // a second pass inside the window (every return to the window runs one) reads no bundle
    first.unmount();
    const eventReads = () => supa.calls.filter((c) => c.table === "events").length;
    const before = eventReads();
    view();
    await settle();
    expect(eventReads()).toBe(before);
  });
});
