import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import type { EventRow, Group, SetlistItem, Song } from "@/lib/types";
import type { EventBundle } from "~/data/event-bundle";
import type { WorkspaceData } from "~/data/workspace";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP SHOW RUNNER — the copy that travels to the venue, and the ONLY
// production caller of ShowReadinessCheck.
//
// Round 10's most common defect was a fix that COULD NOT EXECUTE: the guard was
// written, the prop was declared, and nothing ever passed it — green all the way
// to the stage, where a green "พร้อมโชว์ออฟไลน์" sat over a track that plays
// nothing. The repair (passing `setlist` here) is protected by a comment and
// nothing else. THIS is the trace from a real entry point — a route, a bundle, a
// workspace — down to the props the card is actually handed.
//
// The readiness card is MOCKED to a prop recorder on purpose: the subject is the
// WIRING, not the card's own rendering (which components/event/show-readiness-
// check.test.tsx covers against the real thing). LiveMode is mocked for the same
// reason and one more — it is ~2.5k lines of show transport whose mount cost has
// no business inside a prop-wiring test, and its absence is itself an assertion
// in the permission case below.
// ─────────────────────────────────────────────────────────────────────────────

type ReadinessProps = {
  eventId: string;
  targets: { itemId: string; path: string; name: string }[];
  localOnly?: { itemId: string; songId: string; name: string }[];
  setlist?: readonly { id: string; kind: string; title?: string | null }[];
};

const h = vi.hoisted(() => ({
  bundle: null as unknown,
  ws: null as unknown,
  readiness: [] as Record<string, unknown>[],
}));

vi.mock("~/data/event-bundle", () => ({
  loadEventBundle: vi.fn(() => Promise.resolve(h.bundle)),
}));

vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));

// Spelled out inline rather than through a shared helper: vi.mock factories are
// hoisted above every top-level binding, so a helper would be in its TDZ when
// live.tsx's own imports run.
vi.mock("@/components/event/show-readiness-check", () => ({
  ShowReadinessCheck: (props: Record<string, unknown>) => {
    h.readiness.push(props);
    return <div data-testid="readiness-card" />;
  },
}));

vi.mock("@/components/event/live-mode", () => ({
  LiveMode: () => <div data-testid="live-mode" />,
}));

import { LivePage } from "./live";

const EVENT_ID = "ev-1";
const GROUP_ID = "band-1";

const GROUP: Group = {
  id: GROUP_ID,
  tenant_id: "tenant-a",
  name: "Seishin Kakumei",
} as unknown as Group;

const EVENT: EventRow & { group: Group | null } = {
  id: EVENT_ID,
  tenant_id: "tenant-a",
  group_id: GROUP_ID,
  name: "Summer Live",
  event_date: "2026-08-20",
  venue: "Hall A",
  event_type: "idol",
  show_start_time: "18:00:00",
  hard_out_time: null,
  status: "approved",
  notes: null,
  map_url: null,
  costume_theme: null,
  share_token: null,
  share_expires_at: null,
  deadline: null,
  deadline_note: null,
  last_run_seconds: null,
  last_run_at: null,
  is_template: false,
  is_practice: false,
  created_by: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  group: GROUP,
};

function row(over: Partial<SetlistItem> & { id: string }): SetlistItem {
  return {
    tenant_id: "tenant-a",
    event_id: EVENT_ID,
    kind: "song",
    title: "",
    duration_seconds: 240,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    sort_order: 0,
    song_id: null,
    ...over,
  } as SetlistItem;
}

/**
 * Three rows, one per way a row can relate to audio — the whole point of handing
 * the card all three lists:
 *   • row-playable  → linked to a song WITH a master  → a prefetch target;
 *   • row-orphan    → linked to a song the bundle does not carry → local-only
 *                     candidate (bytes may be on this device, or it goes silent);
 *   • row-ghost     → song_id NULL (the library song was deleted out from under
 *                     it) → claimed by NEITHER resolver, visible only through
 *                     `setlist`. This is the row the preflight exists for.
 */
const SETLIST: SetlistItem[] = [
  row({ id: "row-playable", title: "Opening Number", song_id: "song-1", sort_order: 0 }),
  row({ id: "row-orphan", title: "Orphan Link", song_id: "song-gone", sort_order: 1 }),
  row({ id: "row-ghost", title: "Ghost Track", song_id: null, sort_order: 2 }),
];

const SONGS: Song[] = [
  {
    id: "song-1",
    tenant_id: "tenant-a",
    group_id: GROUP_ID,
    title: "Opening Number",
    file_name: "opening.wav",
    duration_seconds: 240,
    language: null,
    category: null,
    copyright_status: "cleared",
    notes: null,
    audio_path: "tenant-a/band-1/opening-abc123.wav",
    audio_name: "opening.wav",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  },
];

const BUNDLE: EventBundle = {
  event: EVENT,
  schedule: [],
  setlist: SETLIST,
  micMap: [],
  members: [],
  songs: SONGS,
  lineup: [],
  role: "member",
};

/** A band member of GROUP_ID — may VIEW the event (so Live Mode opens to rehearse)
 *  but not live-edit. canViewGroup is the gate live.tsx checks. */
function memberOf(groupId: string): WorkspaceData {
  return {
    user: { id: "u1", email: "seishin-mem@cueiq.local", name: "Member" },
    membership: { tenant_id: "tenant-a", role: "member" },
    tenant: null,
    groups: [],
    groupRoles: [{ group_id: groupId, role: "member" }],
    perms: makePerms("member", [{ group_id: groupId, role: "member" }]),
  };
}

function renderLive() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}/live`]}>
      <Routes>
        <Route path="/events/:id/live" element={<LivePage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** The props of the LAST render of the mocked card. */
function lastReadinessProps(): ReadinessProps {
  // Index arithmetic, not Array.prototype.at: desktop/tsconfig.json targets ES2020,
  // where `at` does not exist in the lib — the root project's ES2022 lib made this
  // compile in one place and fail in the other.
  const props = h.readiness[h.readiness.length - 1];
  expect(props, "ShowReadinessCheck was never rendered").toBeDefined();
  return props as unknown as ReadinessProps;
}

beforeEach(() => {
  h.bundle = BUNDLE;
  h.ws = memberOf(GROUP_ID);
  h.readiness = [];
});

describe("desktop Show Runner — what the preflight is actually handed", () => {
  it("passes the setlist through, alongside targets and localOnly", async () => {
    renderLive();
    await screen.findByTestId("readiness-card");

    const props = lastReadinessProps();
    expect(props.eventId).toBe(EVENT_ID);

    // THE ASSERTION THIS FILE EXISTS FOR. `setlist` is optional on the card and was
    // omitted for a whole round; omit it again and `silent` is hard-wired to [],
    // the reconciliation never runs, and row-ghost is invisible everywhere.
    expect(props.setlist).toBeDefined();
    expect(props.setlist?.length).toBeGreaterThan(0);
    expect(props.setlist?.map((r) => r.id)).toEqual([
      "row-playable",
      "row-orphan",
      "row-ghost",
    ]);

    // The other two lists must still be the resolved ones, not the raw rows — the
    // card reconciles `setlist` AGAINST them, so handing it three copies of the
    // same thing would make every row look accounted for.
    expect(props.targets?.map((t) => t.itemId)).toEqual(["row-playable"]);
    expect(props.targets?.[0].path).toBe("tenant-a/band-1/opening-abc123.wav");
    expect(props.localOnly?.map((c) => c.itemId)).toEqual(["row-orphan"]);
    expect(props.localOnly?.[0].songId).toBe("song-gone");

    // …and the row neither resolver claimed reaches the card ONLY through setlist.
    const accounted = new Set([
      ...(props.targets ?? []).map((t) => t.itemId),
      ...(props.localOnly ?? []).map((c) => c.itemId),
    ]);
    expect(accounted.has("row-ghost")).toBe(false);
    expect(props.setlist?.some((r) => r.id === "row-ghost")).toBe(true);
  });

  it("mounts Live Mode for a viewer of the band", async () => {
    renderLive();
    expect(await screen.findByTestId("live-mode")).toBeInTheDocument();
  });
});

describe("desktop Show Runner — a band that may not open this show", () => {
  it("renders the not-found branch and never mounts Live Mode", async () => {
    // A member of a DIFFERENT band. RLS would refuse the reads anyway, but the page
    // must not depend on that: canViewGroup is the check, and the failure mode being
    // guarded is a Show Runner that mounts (and starts driving audio for) another
    // band's show.
    h.ws = memberOf("some-other-band");

    const { container } = renderLive();

    // The escape hatch back to the dashboard is what marks this branch; matched by
    // its href rather than its Thai label so a copy edit cannot break the test.
    await vi.waitFor(() => {
      expect(container.querySelector('a[href="/dashboard"]')).not.toBeNull();
    });
    expect(screen.queryByTestId("live-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("readiness-card")).not.toBeInTheDocument();
    expect(h.readiness).toHaveLength(0);
  });

  it("renders the same branch when the bundle itself is gone", async () => {
    // Deleted event, or an offline cold boot on a device that never opened this
    // show while online — either way there is nothing to run.
    h.bundle = null;

    const { container } = renderLive();

    await vi.waitFor(() => {
      expect(container.querySelector('a[href="/dashboard"]')).not.toBeNull();
    });
    expect(screen.queryByTestId("live-mode")).not.toBeInTheDocument();
  });
});
