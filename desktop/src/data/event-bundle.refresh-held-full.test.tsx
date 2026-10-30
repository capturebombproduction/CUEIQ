// The held-bundle re-read on a FULL read-cache. 2026-10-30, hunt 10: the dashboard re-reads
// every upcoming show this laptop holds (event-bundle.refresh-held.test.tsx), but once the
// origin's ~5 M chars were used up the newer copy could not be written - silently - and
// the badge drawn a moment before kept saying พร้อมออฟไลน์ over last week's set. The
// show now reads as not ready (its older copy stays on disk for a no-wifi venue).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
// server TODAY: B then A (reordered on a phone), with notes - the new copy is ~6 K bigger
// than the one the laptop cached last week (A then B)
const SERVER_ITEMS = [item("row-b", "song-b", 1), item("row-a", "song-a", 2)].map((r) => ({ ...r, notes: "n".repeat(3_000) }));
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

const QUOTA = 5_000_000; // jsdom's per-origin localStorage quota, in UTF-16 code units
function fillLeaving(free: number) {
  let used = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)!;
    used += k.length + (window.localStorage.getItem(k) ?? "").length;
  }
  const key = "cueiq:cache:workspace"; // not a bundle: never dropped
  window.localStorage.setItem(key, "w".repeat(QUOTA - used - key.length - free));
}

describe("dashboard: a held show whose newer copy cannot be written (cache full)", () => {
  it("stops calling it ready, offers to prepare it, and keeps the older copy", async () => {
    fillLeaving(1_000);
    const held = window.localStorage.getItem("cueiq:cache:event:s1");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ConfirmProvider>
          <Dashboard />
        </ConfirmProvider>
      </MemoryRouter>
    );
    await act(async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    });
    // the re-read happened…
    expect(supa.calls.filter((c) => c.table === "events").length).toBeGreaterThan(0);
    // …could not be written, and the badge says so
    expect(window.localStorage.getItem("cueiq:cache:event:s1")).toBe(held);
    await waitFor(() => expect(screen.queryByText("พร้อมออฟไลน์")).toBeNull());
    expect(screen.getByText("ยังไม่มีข้อมูลงาน")).toBeTruthy();
    expect(screen.getByRole("button", { name: /เตรียมทุกงานที่จะถึง/ })).toBeTruthy();
  });
});
