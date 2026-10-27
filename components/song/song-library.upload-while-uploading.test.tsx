// Hunt 7 (2026-10-27), song-6: a replace started from the row's upload button was still on its
// way when the edit dialog picked another file and saved. Two uploads ran on one song and the one
// that FINISHED last became the master - the big take picked first overwrote the one picked after.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  uploads: [] as string[],
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
  // the big take from the row: still going
  uploadEventAudio: (path: string) => {
    h.uploads.push(path);
    return new Promise<void>(() => {});
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
  detectAudioDuration: async () => 200,
  audioOpenProblem: async () => null,
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () =>
            Object.assign(Promise.resolve({ data: [{ id: "s1", copyright_status: "pending" }], error: null }), {
              single: async () => ({ data: { ...song, ...values }, error: null }),
            }),
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
  copyright_status: "pending",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.uploads.length = 0;
  h.toast.error.mockClear();
});

describe("edit dialog saves a new file while the row is still uploading one", () => {
  it("does not start a second upload of the same song", async () => {
    const { container } = render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(container.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Neon Lullaby"]') as HTMLElement);
    const rowInput = container.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    fireEvent.change(rowInput, { target: { files: [new File(["big"], "take-big.wav", { type: "audio/wav" })] } });
    await waitFor(() => expect(h.uploads).toHaveLength(1));

    const phone = document.querySelector('[class~="md:hidden"].stack') as HTMLElement;
    fireEvent.click(within(phone).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["small"], "take-small.wav", { type: "audio/wav" })] } });
    await waitFor(() =>
      expect((within(dialog).getByLabelText("ความยาว (m:ss)") as HTMLInputElement).value).toBe("3:20")
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.uploads).toHaveLength(1);
  });
});
