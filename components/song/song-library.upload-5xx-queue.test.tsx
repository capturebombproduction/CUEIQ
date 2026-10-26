// Hunt 3 (2026-10-27), songs-1b: presign (or R2) answers 503 at the venue. audio-remote attaches
// the status (httpError) precisely so a sick server stays retryable - but uploadSongAudio
// hands tryQueueAudioUpload only the Thai message, and tryQueueAudioUpload has no status
// parameter, so isQueueableWriteError("ขอลิงก์ put ไม่สำเร็จ (503)", onLine=true) = false:
// the desktop does not keep the picked take.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  queued: [] as Record<string, unknown>[],
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
  tryQueueAudioUpload: async (args: Record<string, unknown>) => {
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
  // what presign()/R2 throw: a Thai message + the HTTP status
  uploadEventAudio: async () => {
    throw Object.assign(new Error("ขอลิงก์ put ไม่สำเร็จ (503)"), { status: 503 });
  },
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1", tenant_id: "t1", group_id: "g1", title: "Neon Lullaby", file_name: "take-1.wav",
  duration_seconds: 150, copyright_status: "pending", audio_path: "t1/g1/songs/s1-old.wav", audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.queued.length = 0;
});

describe("row upload: presign answers 503", () => {
  it("is classified as transient, so the desktop keeps the take", async () => {
    const { container } = render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(container.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Neon Lullaby"]') as HTMLElement);
    fireEvent.change(container.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement, {
      target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] },
    });
    await waitFor(() => expect(h.queued).toHaveLength(1));
    const a = h.queued[0] as { errorMessage?: string | null; errorStatus?: number | null };
    expect(isQueueableWriteError(a.errorMessage ?? null, true, a.errorStatus ?? null)).toBe(true);
  });
});
