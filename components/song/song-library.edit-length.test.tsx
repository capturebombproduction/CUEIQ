// the edit dialog writes back a length it read
// BEFORE the new file was measured.
//
// After a file is replaced, uploadSongAudio measures it in the background
// (measureUploadedSong → writeSongFileFacts: decode + loudness + beat tracking, seconds for a
// long WAV) and writes the file's real length. openEdit copies the song's length into the
// form at the moment the dialog opens, and onSave sends EVERY field back
// (`duration_seconds: …parseDurationToSeconds(form.durationStr)`), changed or not. Rename the
// song while the measurement is still running and the old take's length is written over the
// new take's — the setlist builder copies it into new rows and Live's Auto advances on it.
// The copyright field already got this treatment (sent only when changed, ~765); the length
// did not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  releaseAnalysis: null as null | (() => void),
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
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
// the new take is 5:12; decoding it for loudness/beat takes a while
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: async () => 312,
}));
vi.mock("@/lib/song-analysis-browser", () => ({
  analyzeAudioFile: () =>
    new Promise((resolve) => {
      h.releaseAnalysis = () => resolve({ lufs: -8, peaks: "A".repeat(200), beat_offset: 0.2, bpm: 120 });
    }),
}));
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
              copyright_status: "cleared",
              audio_path: "t1/g1/songs/s1-new.wav",
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
  file_name: null,
  duration_seconds: 150, // the OLD take: 2:30
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.releaseAnalysis = null;
});

describe("SongLibrary — a rename right after a replace", () => {
  it("does not write the old take's length over the new take's measured length", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const phone = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
    // 1. replace the file from the song's sheet
    fireEvent.click(within(phone()).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("เปลี่ยนไฟล์เสียง"));
    const input = document.querySelector('input[type="file"][accept="audio/*"].hidden') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] } });
    // 2026-10-30 (hunt 10): a replace asks first (confirmReplaceFile) - answer it
    fireEvent.click(await screen.findByRole("button", { name: "แทนที่ไฟล์" }));
    await waitFor(() => expect(h.releaseAnalysis).not.toBeNull()); // uploaded; measuring…

    // 2. while it is measuring, open แก้ไข to fix the title
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Neon Lullaby (v2)" } });

    // 3. the measurement lands (5:12), then the user presses บันทึก
    await act(async () => h.releaseAnalysis!());
    await waitFor(() => expect(h.writes.some((w) => w.values.duration_seconds === 312)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(h.writes.some((w) => w.values.title === "Neon Lullaby (v2)")).toBe(true));

    const lengths = h.writes.filter((w) => "duration_seconds" in w.values).map((w) => w.values.duration_seconds);
    // the last length written must be the file's own, not the 2:30 the form was opened with
    expect(lengths.at(-1)).toBe(312);
  });
});
