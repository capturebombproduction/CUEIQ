// Hunt 3 (2026-10-27), songs-1: the R2 PUT lands, then the row update that points the song
// at it fails on the network. supabase-js hands back a PLAIN error object (not an Error),
// uploadSongAudio throws it, and the catch turns it into String(e) = "[object Object]":
//  - the toast reads "อัปโหลดไม่สำเร็จ — [object Object]"
//  - the desktop queue classifier (isQueueableWriteError) gets "[object Object]" and
//    refuses to queue the bytes while navigator.onLine is true.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  queued: [] as { errorMessage?: string | null }[],
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
  // record what the desktop sink would be asked to classify
  tryQueueAudioUpload: async (args: { errorMessage?: string | null }) => {
    h.queued.push(args);
    return false;
  },
}));
vi.mock("@/lib/mgmt-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/mgmt-outbox")>()),
  MGMT_OUTBOX_EVENT: "cueiq-test-outbox",
}));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  uploadEventAudio: async () => {}, // the 88 MB PUT landed
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
// exactly what postgrest-js returns when the fetch itself fails (status 0)
const NET_ERR = { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: () => {
        const chain = {
          eq: () => chain,
          select: async () => ({ data: null, error: NET_ERR, status: 0 }),
        };
        return chain;
      },
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: NET_ERR }),
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
  h.queued.length = 0;
  h.toast.error.mockClear();
});

describe("row upload: PUT landed, row update failed on the network", () => {
  it("says what failed and lets the desktop queue read it", async () => {
    const { container } = render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const btn = container.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Neon Lullaby"]') as HTMLElement;
    fireEvent.click(btn);
    const input = container.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] } });
    // 2026-10-30 (hunt 10): a replace asks first (confirmReplaceFile) - answer it
    fireEvent.click(await screen.findByRole("button", { name: "แทนที่ไฟล์" }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    const [, opts] = h.toast.error.mock.calls[0] as [string, { description?: string }];
    expect.soft(opts?.description).not.toBe("[object Object]");

    expect(h.queued).toHaveLength(1);
    // online (navigator.onLine true) but the request never reached the server: queueable
    expect.soft(h.queued[0].errorMessage).not.toBe("[object Object]");
    expect(isQueueableWriteError(h.queued[0].errorMessage ?? null, true)).toBe(true);
  });
});
