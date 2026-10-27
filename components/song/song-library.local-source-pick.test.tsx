// Hunt 7 (2026-10-27): the desktop's "ใช้ไฟล์ในเครื่องนี้" refused only AIFF by name, so a file
// this machine's player cannot open (.wma, an ALAC .m4a) became the song's override here and
// played silence at showtime. And a refusal from the main process (ไฟล์ใหญ่เกินไป …) reached
// the toast behind Electron's "Error invoking remote method 'cueiq:pick-audio-file': Error: ".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  stored: [] as string[],
  open: null as null | (() => Promise<string | null>),
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
  setLocalSource: async (songId: string) => {
    h.stored.push(songId);
  },
  clearLocalSource: async () => {},
  listLocalSourceIds: async () => new Set<string>(),
}));
vi.mock("@/lib/mgmt-write", () => ({
  listPendingAudioUploads: async () => new Set<string>(),
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  audioOpenProblem: () => (h.open ? h.open() : Promise.resolve(null)),
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";
import { UNOPENABLE_AUDIO_MESSAGE } from "@/lib/audio";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  duration_seconds: 150,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

let pick: () => Promise<unknown>;

beforeEach(() => {
  document.body.innerHTML = "";
  h.stored.length = 0;
  h.open = null;
  h.toast.error.mockClear();
  (window as unknown as { cueiqNative?: unknown }).cueiqNative = { pickAudioFile: () => pick() };
});
afterEach(() => {
  delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
});

async function pressUseLocalFile() {
  render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
  const phone = document.querySelector('[class~="md:hidden"].stack') as HTMLElement;
  fireEvent.click(within(phone).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
  const sheet = screen.getByRole("dialog");
  fireEvent.click(within(sheet).getByTitle("เล่นเพลงนี้จากไฟล์ในเครื่องนี้แทนต้นฉบับ (เฉพาะเครื่องนี้)"));
}

describe("desktop: ใช้ไฟล์ในเครื่องนี้", () => {
  it("refuses a file this machine's player cannot open", async () => {
    pick = async () => ({ name: "take-2.wma", bytes: new Uint8Array([1, 2, 3]) });
    h.open = async () => UNOPENABLE_AUDIO_MESSAGE;
    await pressUseLocalFile();
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("ใช้ไฟล์นี้ไม่ได้", { description: UNOPENABLE_AUDIO_MESSAGE })
    );
    expect(h.stored).toHaveLength(0);
  });

  it("shows the main process's own reason, without Electron's IPC prefix", async () => {
    pick = async () => {
      throw new Error(
        "Error invoking remote method 'cueiq:pick-audio-file': Error: ไฟล์ใหญ่เกินไป (812 MB) — รับไฟล์เสียงไม่เกิน 500 MB"
      );
    };
    await pressUseLocalFile();
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("ตั้งไฟล์ในเครื่องไม่สำเร็จ", {
        description: "ไฟล์ใหญ่เกินไป (812 MB) — รับไฟล์เสียงไม่เกิน 500 MB",
      })
    );
  });

  it("still takes a file the player opens", async () => {
    pick = async () => ({ name: "take-2.wav", bytes: new Uint8Array([1, 2, 3]) });
    await pressUseLocalFile();
    await waitFor(() => expect(h.stored).toEqual(["s1"]));
  });
});
