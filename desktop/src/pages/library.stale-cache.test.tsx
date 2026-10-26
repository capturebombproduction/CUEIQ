// Hunt 3 (2026-10-27), songs-4: คลังเพลง opened with no (or slow, >8 s) network serves the
// read-cache - a catalogue that can be days old. SongLibrary's mount effect then runs
// pruneSupersededSongs with THAT map, and deletes from the shared song cache every blob
// whose path is not the cached audio_path - including the CURRENT master this laptop
// pulled with เตรียมเพลง after someone replaced the file (practice + preview read it).
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { Song } from "@/lib/types";

const h = vi.hoisted(() => ({ pruned: [] as Map<string, string | null>[] }));

const stale = {
  id: "s1", tenant_id: "t1", group_id: "g1", title: "Neon Lullaby", file_name: "take-1.wav",
  duration_seconds: 150, copyright_status: "cleared", audio_path: "t1/g1/songs/s1-OLD.wav", audio_name: "take-1.wav",
} as unknown as Song;

vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({
    ws: {
      membership: { tenant_id: "t1" },
      tenant: { id: "t1", name: "A Lot Of Tone" },
      perms: makePerms("admin"),
      groups: [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" }],
    },
  }),
}));
vi.mock("~/data/song-library", () => ({
  fetchSongs: async () => null, // offline / 8 s timeout / untrusted read
  readCachedSongs: () => [stale],
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: async () => new Blob(["x"]),
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
  listPendingAudioUploads: async () => new Set<string>(),
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/temp-song-purge", async (orig) => ({
  ...(await orig<typeof import("@/lib/temp-song-purge")>()),
  fetchServerNowMs: async () => null,
}));

import { Library } from "~/pages/library";

describe("desktop คลังเพลง served from the read-cache", () => {
  it("does not prune the song cache against a catalogue it could not refresh", async () => {
    const { findByText } = render(
      <MemoryRouter>
        <ConfirmProvider>
          <Library />
        </ConfirmProvider>
      </MemoryRouter>
    );
    await findByText("Neon Lullaby", undefined, { timeout: 3000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() => expect(document.body.textContent).toContain("Neon Lullaby"));
    expect(h.pruned).toHaveLength(0);
  });
});
