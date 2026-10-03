// A song's new file brings its own facts (lib/song-file-facts.ts). Live draws the waveform on
// the FILE's length (songs.duration_seconds), so replacing a file from the song's sheet must
// not leave the last take's length or waveform behind: the write that points the song at the
// new file clears the old analysis, and the new file's length and analysis follow, aimed at
// that file only. The edit dialog is the exception for the length - it saved the one it
// showed the user, who may have changed it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const MEASURED = { lufs: -8.4, peaks: "A".repeat(200), beat_offset: 0.31, bpm: 174 };
const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown>; eqs: [string, unknown][] }[],
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
            return Object.assign(Promise.resolve({ data: [{ id }], error: null }), {
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
});

describe("SongLibrary — a new file brings its own facts", () => {
  it("replacing a file: the old take's analysis goes in the same write, then the new length and analysis follow it", async () => {
    mount(song());
    fireEvent.click(within(phoneList()).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("เปลี่ยนไฟล์เสียง"));
    fireEvent.change(audioInput(), { target: { files: [TAKE_2] } });

    await waitFor(() => expect(h.writes).toHaveLength(2));
    const [point, facts] = h.writes;
    expect(point.values).toMatchObject({ audio_name: "take-2.wav", lufs: null, peaks: null, beat_offset: null });
    expect(point.values).not.toHaveProperty("bpm"); // practice mode's tempo is the user's
    const newPath = point.values.audio_path;
    expect(newPath).not.toBe("t1/g1/s1/take-1.wav");
    // 2:30 was the last take's; this one is 5:12. bpm 87 stays.
    expect(facts.values).toEqual({ duration_seconds: 312, lufs: -8.4, peaks: MEASURED.peaks, beat_offset: 0.31 });
    expect(facts.eqs).toEqual([
      ["id", "s1"],
      ["audio_path", newPath],
    ]);
  });

  it("the edit dialog keeps the length it saved: the user typed 2:30 over the detected 5:12", async () => {
    mount(song({ audio_path: null, audio_name: null, lufs: null, peaks: null, beat_offset: null }));
    fireEvent.click(within(phoneList()).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [TAKE_2] } });
    const length = await within(dialog).findByDisplayValue("5:12");
    fireEvent.change(length, { target: { value: "2:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));

    await waitFor(() => expect(h.writes.some((w) => "peaks" in w.values && w.values.peaks === MEASURED.peaks)).toBe(true));
    expect(h.writes[0].values).toMatchObject({ duration_seconds: 150 });
    // nothing after the save writes a length over the user's
    expect(h.writes.slice(1).some((w) => "duration_seconds" in w.values)).toBe(false);
  });
});
