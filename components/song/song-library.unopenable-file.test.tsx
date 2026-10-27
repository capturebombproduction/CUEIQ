// Hunt 7 (2026-10-27), song-1: accept="audio/*" lets through files Chromium (the show laptop,
// Chrome, Edge) cannot open at all - .wma, .amr, an ALAC .m4a from Apple Music. The edit
// dialog's length detection said "เปิดไฟล์เสียงไม่สำเร็จ — ฟอร์แมตอาจไม่รองรับ" but KEPT the file
// picked, and บันทึก made it the master: the old take deleted from R2, a green "มีไฟล์" badge,
// and every device silent on that row at showtime. The row's ⬆ only refused AIFF by name.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
  uploads: [] as string[],
  removed: [] as string[],
  detect: null as null | (() => Promise<number>),
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
  uploadEventAudio: async (path: string) => {
    h.uploads.push(path);
  },
  removeEventAudio: async (path: string) => {
    h.removed.push(path);
  },
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: () => (h.detect ? h.detect() : Promise.resolve(200)),
  audioOpenProblem: () => (h.open ? h.open() : Promise.resolve(null)),
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
            const row = { ...song, ...values };
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
import { UNOPENABLE_AUDIO_MESSAGE } from "@/lib/audio";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  file_name: "take-1.wav",
  duration_seconds: 150,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

function renderLib() {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
}

async function openEditDialog() {
  const phone = document.querySelector('[class~="md:hidden"].stack') as HTMLElement;
  fireEvent.click(within(phone).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
  return screen.findByRole("dialog", { name: "Edit Song" });
}

const pointedAtNewFile = () => h.writes.some((w) => typeof w.values.audio_path === "string");

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.uploads.length = 0;
  h.removed.length = 0;
  h.detect = null;
  h.open = null;
  h.toast.error.mockClear();
  h.toast.success.mockClear();
});

describe("a file this device's player cannot open", () => {
  it("is dropped from the edit dialog when picked, and บันทึก uploads nothing", async () => {
    h.detect = () =>
      Promise.reject(Object.assign(new Error("เปิดไฟล์เสียงไม่สำเร็จ — ฟอร์แมตอาจไม่รองรับ"), { cueiqUnopenable: true }));
    renderLib();
    const dialog = await openEditDialog();
    const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["wma"], "take-2.wma", { type: "audio/x-ms-wma" })] } });
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("ใช้ไฟล์นี้ไม่ได้", { description: UNOPENABLE_AUDIO_MESSAGE })
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(h.uploads).toHaveLength(0);
    expect(pointedAtNewFile()).toBe(false);
  });

  it("is refused by the row upload: the song keeps its take and the fresh object is taken back", async () => {
    h.open = async () => UNOPENABLE_AUDIO_MESSAGE;
    const { container } = renderLib();
    fireEvent.click(container.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Neon Lullaby"]') as HTMLElement);
    const input = container.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["m4a"], "take-2.m4a", { type: "audio/mp4" })] } });
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("ใช้ไฟล์นี้ไม่ได้", { description: UNOPENABLE_AUDIO_MESSAGE })
    );
    expect(pointedAtNewFile()).toBe(false);
    expect(h.removed).toEqual(h.uploads); // only the fresh key, never the song's own take
    expect(h.removed).not.toContain("t1/g1/songs/s1-old.wav");
  });

  it("still uploads a file whose LENGTH alone could not be read (the user types it)", async () => {
    h.detect = () => Promise.reject(new Error("อ่านความยาวไฟล์ไม่ได้ — ลองกรอกเองได้"));
    renderLib();
    const dialog = await openEditDialog();
    const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] } });
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("ตรวจความยาวไม่สำเร็จ", expect.anything()));
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(pointedAtNewFile()).toBe(true));
    expect(h.uploads).toHaveLength(1);
  });
});
