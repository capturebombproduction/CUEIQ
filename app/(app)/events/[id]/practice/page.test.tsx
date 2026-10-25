// ---------------------------------------------------------------------------
// A FAILED READ IN THE PRACTICE ROOM IS NOT "NO MARKERS" / "NO SONGS".
//
// 2026-10-25 review: the room coalesced a failed song_markers or practice_songs read to
// [] and opened looking empty - no section markers, an empty practice list - so the Ar
// re-adds the markers (duplicates once the read works again) and the band re-picks the
// songs. Same rule as cdd7435 (lib/read-guard.ts): throw to the (app) error boundary.
// An async Server Component: it is called, and the returned tree is searched.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";

const h = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/queries", () => ({
  getEventBundle: async () => ({
    event: { id: "room-1", name: "ซ้อมใหญ่", group_id: "band-1", tenant_id: "t1", is_practice: true },
    songs: [],
    members: [],
  }),
  getWorkspace: async () => ({
    user: { id: "u1", email: "ar@cueiq.local", name: "Ar" },
    membership: { tenant_id: "t1", role: "member" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [],
    groupRoles: [{ group_id: "band-1", role: "artist_manager" }],
    perms: makePerms("member", [{ group_id: "band-1", role: "artist_manager" }]),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/practice/practice-mode", () => ({ PracticeMode: () => null }));

import PracticePlayPage from "./page";
import { PracticeMode } from "@/components/practice/practice-mode";

function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? null;
  return el.props ? findProps(el.props.children, type) : null;
}

const open = () => PracticePlayPage({ params: Promise.resolve({ id: "room-1" }) });
const MARKER = { id: "m1", song_id: "s1", group_id: "band-1", position_seconds: 12, label: "Verse" };
const SONG = { id: "ps1", event_id: "room-1", song_id: "s1", sort_order: 0 };

describe("the practice room", () => {
  it.each(["song_markers", "practice_songs"])("a failed %s read throws, never an empty room", async (table) => {
    h.server = makeSupabaseFake({
      session: makeSession(),
      script: {
        song_markers: ok([MARKER]),
        practice_songs: ok([SONG]),
        [table]: fail("canceling statement due to statement timeout", 500),
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(open()).rejects.toThrow();
  });

  it("reads that worked reach the room", async () => {
    h.server = makeSupabaseFake({
      session: makeSession(),
      script: { song_markers: ok([MARKER]), practice_songs: ok([SONG]) },
    });

    const props = findProps(await open(), PracticeMode);

    expect(props?.markersBySong).toEqual({ s1: [MARKER] });
    expect(props?.practiceList).toEqual([SONG]);
  });
});
