// Hunt 7 (2026-10-27), song-4: on the desktop, a take picked offline waits as "รออัปโหลด".
// When the outbox flushes it (desktop/src/data/mgmt-outbox.ts writes songs.audio_path and
// clears the local override), the Library open on screen only dropped the badge: the row kept
// the path it was read with, so a song that now HAS a master read "ไม่มีไฟล์เสียง" until a
// reload, and the next edit's cache sweep ran on that old path and threw the cached take away.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  pending: new Set<string>(["s1"]),
  reads: [] as string[][],
  pruned: [] as Map<string, string | null>[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: async () => new Blob(["x"], { type: "audio/wav" }),
  cacheSongBlob: async () => {},
  pruneSupersededSongs: async (m: Map<string, string | null>) => {
    h.pruned.push(new Map(m));
    return 0;
  },
}));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  setLocalSource: async () => {},
  clearLocalSource: async () => {},
  listLocalSourceIds: async () => new Set<string>(),
}));
vi.mock("@/lib/mgmt-write", () => ({
  listPendingAudioUploads: async () => new Set(h.pending),
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          h.reads.push(ids);
          return {
            data: [{ ...song, audio_path: "t1/g1/songs/s1-landed.wav", audio_name: "take-venue.wav" }],
            error: null,
          };
        },
      }),
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  duration_seconds: 150,
  copyright_status: "pending",
  audio_path: null, // its first master was the take picked offline
  audio_name: null,
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.pending = new Set(["s1"]);
  h.reads.length = 0;
  h.pruned.length = 0;
});

describe("a queued take lands while the Library is open", () => {
  it("re-reads that song, so the row shows its new master", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.queryAllByText("รออัปโหลด").length).toBeGreaterThan(0));
    // the flush landed and fired the outbox event
    h.pending = new Set();
    await act(async () => {
      window.dispatchEvent(new Event("cueiq-test-outbox"));
    });
    await waitFor(() => expect(h.reads).toEqual([["s1"]]));
    await waitFor(() => expect(screen.queryAllByText("มีไฟล์").length).toBeGreaterThan(0));
    // and the cache sweep now knows the landed path, not the stale one
    expect(h.pruned.at(-1)?.get("s1")).toBe("t1/g1/songs/s1-landed.wav");
  });
});
