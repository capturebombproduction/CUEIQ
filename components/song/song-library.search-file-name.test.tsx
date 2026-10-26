// 2026-10-27 hunt: search matches the file name the row prints. c4388cf made every row
// show the file it plays now (audio_name) while the search still looked only at file_name,
// so typing the name on screen found nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

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
  tryQueueAudioUpload: async () => false, // the web: nothing to queue into
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  // venue wifi drops the 88 MB PUT
  uploadEventAudio: async () => {
    throw new Error("Failed to fetch");
  },
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: async () => 312, // the new take: 5:12
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            h.writes.push({ values });
            const row = {
              id: "s1",
              tenant_id: "t1",
              group_id: "g1",
              title: "Neon Lullaby",
              file_name: "take-1.wav",
              duration_seconds: 150,
              copyright_status: "cleared",
              audio_path: "t1/g1/songs/s1-old.wav",
              audio_name: "take-1.wav",
              ...values,
            };
            return Object.assign(Promise.resolve({ data: [{ id: "s1", copyright_status: "cleared" }], error: null }), {
              single: async () => ({ data: row, error: null }),
            });
          },
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  file_name: "take-1.wav",
  duration_seconds: 150, // the OLD take, 2:30, which is what still plays
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
});
// (song fixture above is reused: file_name "take-1.wav" = the name it was created with)
const replaced = { ...song, audio_name: "take-2-final.wav", audio_path: "t1/g1/songs/s1-new.wav" } as Song;

describe("the file name the row shows is not the one search looks at", () => {
  it("finds the song by the file name printed under its title", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[replaced]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    // the row names the file it plays now (c4388cf shownFileName)
    expect(screen.getAllByText("take-2-final.wav").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("searchbox", { name: "ค้นหาเพลง" }), { target: { value: "take-2-final" } });
    // typing the name the row shows must keep the row
    expect(screen.queryByText("ไม่พบเพลงที่ตรงกับการค้นหา / ตัวกรอง")).toBeNull();
  });
});
