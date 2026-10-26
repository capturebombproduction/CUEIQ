// after a file is replaced (or removed), คลังเพลง keeps
// naming the OLD file.
//
// Every row, and the song's sheet ("Audio" section), prints `song.file_name`
// (components/song/song-library.tsx ~1905 and ~2158). uploadSongAudio — the ⬆ in the table,
// "เปลี่ยนไฟล์เสียง" in the sheet, "ดันขึ้นเป็นต้นฉบับ" — writes only `audio_name`
// (lib/types.ts: "original filename, for display"), and removeSongAudio clears only
// audio_name. So an Ar who swaps in "take-2.wav" before a show is shown "take-1.wav" on the
// row they just changed — and after removing the file, the old name still sits above
// "ไม่มีไฟล์". Live Mode shows audio_name, so the two screens name different files.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
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
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  uploadEventAudio: async () => {},
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: async () => 200,
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
            return Promise.resolve({ data: [{ id: "s1", copyright_status: "cleared" }], error: null });
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
  duration_seconds: 150,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-aaaaaaaa.wav",
  audio_name: "take-1.wav",
} as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
});

describe("SongLibrary — the file name shown follows the file", () => {
  it("names the new take after the file is replaced from the song's sheet", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const phone = document.querySelector(".stack.md\\:hidden") as HTMLElement;
    fireEvent.click(within(phone).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("เปลี่ยนไฟล์เสียง"));
    const input = document.querySelector('input[type="file"][accept="audio/*"].hidden') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] } });

    await waitFor(() => expect(h.writes.some((w) => w.values.audio_name === "take-2.wav")).toBe(true));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());

    // The song now plays take-2.wav everywhere; the library must not still name take-1.
    expect(screen.queryAllByText("take-1.wav")).toHaveLength(0);
  });
});
