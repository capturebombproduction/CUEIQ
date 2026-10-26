// Hunt 3 (2026-10-27), songs-3: บันทึก on a song with a picked file holds the dialog for the
// whole R2 upload (minutes on venue Wi-Fi), but ยกเลิก / Esc still close it. The user then
// opens the next song (เพิ่มเพลง), types, picks its file - and when the FIRST upload lands,
// onSave's tail (setPickedFile(null); setSaving(false); setOpen(false)) closes THAT dialog
// and drops its picked file. Its บันทึก was disabled ("กำลังบันทึก…") the whole time.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  release: null as null | (() => void),
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
  uploadEventAudio: () => new Promise<void>((res) => { h.release = res; }),
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
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      insert: (values: Record<string, unknown>) => ({
        select: () => ({
          single: async () => ({
            data: { id: "new1", tenant_id: "t1", group_id: "g1", copyright_status: "pending", audio_path: null, ...values },
            error: null,
          }),
        }),
      }),
      update: () => {
        const chain = {
          eq: () => chain,
          select: async () => ({ data: [{ id: "new1", copyright_status: "pending" }], error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";

const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.release = null;
});

describe("a long save, cancelled, then the next song", () => {
  it("does not close the next song's dialog when the first upload lands", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[] as Song[]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเพลง" }));
    let dialog = await screen.findByRole("dialog", { name: "Add Song" });
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "First" } });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["wav"], "first.wav", { type: "audio/wav" })] },
    });
    await waitFor(() => expect((within(dialog).getByLabelText("ความยาว (m:ss)") as HTMLInputElement).value).toBe("3:20"));
    fireEvent.click(within(dialog).getByRole("button", { name: "เพิ่มเพลง" }));
    await waitFor(() => expect(h.release).not.toBeNull()); // the PUT is running
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" })); // "it looks stuck"
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Song" })).toBeNull());

    // the next song
    fireEvent.click(screen.getAllByRole("button", { name: "เพิ่มเพลง" })[0]);
    dialog = await screen.findByRole("dialog", { name: "Add Song" });
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Second" } });

    await act(async () => {
      h.release?.(); // the first song's upload lands
      await new Promise((r) => setTimeout(r, 20));
    });
    // the dialog the user is typing in is still there
    expect(screen.queryByRole("dialog", { name: "Add Song" })).not.toBeNull();
  });
});
