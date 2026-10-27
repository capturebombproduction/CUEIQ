// Hunt 7 (2026-10-27), song-5: ลบเพลง counted only the setlist rows using the song. A song that
// sat in practice rooms' sets and in no show got the plain prompt - and practice_songs goes with
// the song (ON DELETE CASCADE), so it silently vanished from those rooms.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: async () => new Blob(["x"], { type: "audio/wav" }),
  cacheSongBlob: async () => {},
  pruneSupersededSongs: async () => 0,
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
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: async () =>
          table === "practice_songs"
            ? // the song twice in one room's set, once in another room's
              { data: [{ event_id: "room-a" }, { event_id: "room-a" }, { event_id: "room-b" }], error: null }
            : { data: null, count: 0, error: null }, // in no show
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
  title: "Flare Up",
  duration_seconds: 210,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-aaaaaaaa.wav",
} as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SongLibrary — delete a song that is in practice rooms", () => {
  it("says how many rooms lose it", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "ลบเพลง Flare Up" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("ห้องซ้อม 2 ห้อง"));
    expect(dialog.textContent).toContain("เพลงจะหายจากห้องซ้อม");
  });
});
