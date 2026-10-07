// 0047 (พี่ 2026-10-07): a song that passed copyright review and is then given a new file
// (or a new title) by the band goes back to "รอตรวจ" - the server does it. The library
// says so to the person who changed it and tells the admins; a song already pending, or
// a write the server left at its verdict, says nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const MEASURED = { lufs: -8.4, peaks: "A".repeat(200), beat_offset: 0.31, bpm: 174 };
const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown>; eqs: [string, unknown][] }[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  notify: vi.fn(),
  /** what the server answers for copyright_status after the write */
  status: "pending" as string,
}));
vi.mock("@/lib/notify-client", () => ({ notify: h.notify }));

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
// the take that replaces it is 5:12
vi.mock("@/lib/audio", () => ({ detectAudioDuration: async () => 312 }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => MEASURED }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const eqs: [string, unknown][] = [];
        const chain = {
          eq(col: string, v: unknown) {
            eqs.push([col, v]);
            return chain;
          },
          select: () => {
            h.writes.push({ values, eqs });
            const id = eqs.find(([c]) => c === "id")?.[1];
            const one = { id, tenant_id: "t1", group_id: "g1", title: "Neon Lullaby", ...values };
            // .single() for the dialog's save; awaited directly for every other write
            return Object.assign(Promise.resolve({ data: [{ id, copyright_status: h.status }], error: null }), {
              single: async () => ({ data: one, error: null }),
            });
          },
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "./song-library";

const OLD = { lufs: -11, peaks: "z".repeat(200), beat_offset: 0.9, bpm: 87 };
const song = (extra: Partial<Song> = {}): Song =>
  ({
    id: "s1",
    tenant_id: "t1",
    group_id: "g1",
    title: "Neon Lullaby",
    duration_seconds: 150,
    copyright_status: "cleared",
    audio_path: "t1/g1/s1/take-1.wav",
    audio_name: "take-1.wav",
    ...OLD,
    ...extra,
  }) as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

function mount(s: Song) {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[s]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
}
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
const audioInput = () => document.querySelector('input[type="file"][accept="audio/*"].hidden') as HTMLInputElement;
const TAKE_2 = new File(["wav"], "take-2.wav", { type: "audio/wav" });

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.toast.error.mockClear();
  h.toast.info.mockClear();
  h.notify.mockClear();
  h.status = "pending";
});

const replaceFile = () => {
  fireEvent.click(within(phoneList()).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
  fireEvent.click(within(screen.getByRole("dialog")).getByTitle("เปลี่ยนไฟล์เสียง"));
  fireEvent.change(audioInput(), { target: { files: [TAKE_2] } });
};

describe("SongLibrary — a reviewed song given a new file goes back to review", () => {
  it("a cleared song: says it is back to รอตรวจ, and tells the admins", async () => {
    mount(song({ copyright_status: "cleared" }));
    replaceFile();
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith("song_resubmitted", { songId: "s1" }));
    expect(h.toast.info).toHaveBeenCalledWith("เพลงนี้กลับไปรอตรวจลิขสิทธิ์", expect.anything());
  });

  it("a song already pending: nothing to say", async () => {
    mount(song({ copyright_status: "pending" }));
    replaceFile();
    await waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.notify).not.toHaveBeenCalledWith("song_resubmitted", expect.anything());
    expect(h.toast.info).not.toHaveBeenCalled();
  });

  it("an approver's own new file keeps the verdict (the server left it cleared): nothing to say", async () => {
    h.status = "cleared";
    mount(song({ copyright_status: "cleared" }));
    replaceFile();
    await waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.notify).not.toHaveBeenCalled();
  });
});
