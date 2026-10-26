// "เตรียมทุกงานที่จะถึง" never refreshed a run sheet this device already held.
//
// components/event/events-list.tsx computes each upcoming show's readiness from the
// SERVER's current setlist (setlist_items + songs), but the data half was a presence
// check only — `data: cache.isCached(e.id)` — and prepareAll warmed a bundle only
// `if (!r.data)`. So a show whose bundle was cached last week (its page opened once)
// and whose setlist was re-done on the web since:
//   • prepare downloaded the NEW songs' audio (the targets come from the server), and
//   • left last week's bundle on disk — the copy Live Mode opens offline
//     (event-bundle.ts servedFromCache), with last week's setlist / schedule / mics.
// The dashboard then said พร้อม, and at a no-wifi venue the band ran the old set.
//
// Drives the REAL Dashboard → REAL EventsList → REAL bridge (this module's
// window.cueiqEventCache) and asserts what the venue cares about: after prepare, every
// upcoming show's bundle on disk carries the server's setlist.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
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
// The byte half is not the subject. "up"'s new master is not on this device yet;
// "done" holds every file it needs. Fetching succeeds.
vi.mock("@/lib/audio-prefetch", () => ({
  getReadiness: vi.fn(async (eventId: string, targets: unknown[]) => ({
    total: targets.length,
    ready: eventId === "done" ? targets.length : 0,
    stale: 0,
    missing: eventId === "done" ? 0 : targets.length,
  })),
  prefetchEventAudio: vi.fn(async () => ({
    totalTargets: 1,
    fetched: 1,
    skipped: 0,
    failed: 0,
    removedStale: 0,
  })),
}));

import { Dashboard } from "~/pages/dashboard";
import { prefetchEventAudio } from "@/lib/audio-prefetch";

const TENANT = "tenant-a";
const G1: Group = {
  id: "g1",
  tenant_id: TENANT,
  name: "Seishin Kakumei",
  color: null,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z",
} as Group;

const show = (id: string, date: string) => ({
  id,
  tenant_id: TENANT,
  group_id: "g1",
  name: `Show ${id}`,
  event_date: date,
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
});
const UP = show("up", "2026-10-03");
const DONE = show("done", "2026-10-10");

// What the server holds TODAY for each show: the set was re-done on the web after
// this device last opened it.
const item = (id: string, eventId: string, songId: string) => ({
  id, event_id: eventId, song_id: songId, title: songId, sort_order: 1, audio_path: null, audio_name: null,
});
const SERVER_ITEMS = [item("up-new", "up", "song-new"), item("done-new", "done", "song-done")];
const SONGS = [
  { id: "song-new", group_id: "g1", title: "song-new", audio_path: `${TENANT}/g1/song-new-a.wav`, audio_name: "n.wav" },
  { id: "song-done", group_id: "g1", title: "song-done", audio_path: `${TENANT}/g1/song-done-b.wav`, audio_name: "d.wav" },
];

// What this device cached LAST WEEK.
const oldBundle = (ev: ReturnType<typeof show>, oldItemId: string) => ({
  event: { ...ev, groups: undefined, group: G1 },
  schedule: [],
  setlist: [item(oldItemId, ev.id, "song-old")],
  micMap: [],
  members: [],
  songs: [],
  lineup: [],
  role: null,
});

/** The rows of `rows` this chain's .eq / .in filters select. */
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
      events: (c) => ok(filtered([UP, DONE], c)[0] ?? null),
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
    user: { id: "u1", email: "u@cueiq.local", name: "พี่พัชร์" },
    membership: { tenant_id: TENANT, role: "member" },
    tenant: { id: TENANT, name: "A Lot Of Tone" },
    groups: [G1],
    groupRoles: [{ group_id: "g1", role: "member" }],
    perms: makePerms("member", [{ group_id: "g1", role: "member" }]),
  } as unknown as WorkspaceData;
  h.events = [UP, DONE];
  // the Electron bridge: EventsList only runs its offline-prep half under it
  (window as unknown as { cueiqNative?: unknown }).cueiqNative = { isElectron: true };
  window.localStorage.setItem("cueiq:cache:event:up", JSON.stringify(oldBundle(UP, "up-old")));
  window.localStorage.setItem("cueiq:cache:event:done", JSON.stringify(oldBundle(DONE, "done-old")));
  vi.mocked(prefetchEventAudio).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
});

const onDisk = (id: string) =>
  (JSON.parse(window.localStorage.getItem(`cueiq:cache:event:${id}`)!) as { setlist: { id: string }[] }).setlist.map(
    (r) => r.id
  );

async function pressPrepareAll() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <ConfirmProvider>
        <Dashboard />
      </ConfirmProvider>
    </MemoryRouter>
  );
  // "up"'s new opener is missing, so the bulk prepare is offered — the button an
  // operator presses at home before the venue.
  const btn = await screen.findByRole("button", { name: /เตรียมทุกงานที่จะถึง \(1\)/ });
  await act(async () => {
    fireEvent.click(btn);
  });
  await vi.waitFor(() => expect(screen.queryByText(/กำลังเตรียม/)).toBeNull());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("เตรียมทุกงานที่จะถึง with bundles this device cached before the setlists changed", () => {
  it("leaves the CURRENT setlist on disk for the show it prepares, not last week's", async () => {
    await pressPrepareAll();
    expect(onDisk("up")).toEqual(["up-new"]);
  });

  it("re-reads every upcoming show's bundle, even one whose files were all here", async () => {
    await pressPrepareAll();
    expect(onDisk("done")).toEqual(["done-new"]);
    // …without fetching audio for a show that needed none
    expect(vi.mocked(prefetchEventAudio).mock.calls.map((c) => c[0])).toEqual(["up"]);
  });
});
