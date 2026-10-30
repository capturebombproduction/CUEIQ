// 2026-10-30, hunt 10 (mistakes-2): replacing a song's file deletes the take it replaces, for
// good (uploadSongAudio removes prevPath - deliberate, 4767d9d). The file picker went straight to
// the upload, so a wrong file picked for a song that already had one took the master with no
// question - from the sheet's ⬆, the table's ⬆, or the edit dialog's บันทึก with a picked file.
// Now each asks first, naming both files and where the song is used. A first upload asks nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { table: string; values: Record<string, unknown> }[],
  uploads: [] as string[],
  removed: [] as string[],
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
  detectAudioDuration: () => Promise.resolve(200),
  audioOpenProblem: () => Promise.resolve(null),
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => {
  const chain = (table: string): unknown => {
    let values: Record<string, unknown> | null = null;
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "maybeSingle", "single"]) c[m] = () => c;
    c.update = (v: Record<string, unknown>) => {
      values = v;
      return c;
    };
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (values) h.writes.push({ table, values });
      const result =
        table === "setlist_items"
          ? { data: null, count: 2, error: null, status: 200 }
          : table === "songs" && values
            ? { data: [{ id: "s1", copyright_status: "cleared" }], error: null, status: 200 }
            : { data: [], error: null, status: 200 };
      return Promise.resolve(result).then(res, rej);
    };
    return c;
  };
  return {
    createClient: () => ({
      from: (t: string) => chain(t),
      removeChannel() {},
      auth: { getSession: async () => ({ data: { session: { access_token: "x" } }, error: null }) },
    }),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "@/components/song/song-library";

const withFile = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Akai Hana",
  file_name: "akai-hana-final.wav",
  duration_seconds: 228,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "akai-hana-final.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];
const WRONG = new File(["wav"], "other-song.wav", { type: "audio/wav" });
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
const rowInput = () => document.querySelector('input[type="file"][accept="audio/*"].hidden') as HTMLInputElement;

function mount(song: Song) {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
}
async function replacePrompt() {
  return (await screen.findByText(/แทนที่ไฟล์เสียงของ “Akai Hana”/)).closest("[role=dialog]") as HTMLElement;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.uploads.length = 0;
  h.removed.length = 0;
});

describe("SongLibrary — replacing a song's file asks first", () => {
  it("the sheet's ⬆: names both files and the song's use; ยกเลิก uploads, writes and deletes nothing", async () => {
    mount(withFile);
    fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("เปลี่ยนไฟล์เสียง"));
    fireEvent.change(rowInput(), { target: { files: [WRONG] } });
    const prompt = await replacePrompt();
    const text = prompt.textContent ?? "";
    expect(text).toContain("“akai-hana-final.wav” จะถูกแทนด้วย “other-song.wav”");
    expect(text).toContain("ไฟล์เดิมจะถูกลบถาวร กู้คืนไม่ได้");
    expect(text).toContain("2 รายการของงาน");
    fireEvent.click(within(prompt).getByRole("button", { name: "ยกเลิก" }));
    await settle();
    expect(h.uploads).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.removed).toHaveLength(0);
  });

  it("the table's ⬆ answered แทนที่ไฟล์: uploads, points the song at it, and the old take goes", async () => {
    const { container } = mount(withFile);
    fireEvent.click(container.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Akai Hana"]') as HTMLElement);
    fireEvent.change(rowInput(), { target: { files: [WRONG] } });
    fireEvent.click(within(await replacePrompt()).getByRole("button", { name: "แทนที่ไฟล์" }));
    await waitFor(() => expect(h.removed).toEqual(["t1/g1/songs/s1-old.wav"]));
    expect(h.uploads).toHaveLength(1);
    expect(h.writes[0].values).toMatchObject({ audio_path: h.uploads[0], audio_name: "other-song.wav" });
  });

  it("a first upload (no file yet) asks nothing", async () => {
    const { container } = mount({ ...withFile, audio_path: null, audio_name: null } as unknown as Song);
    fireEvent.click(container.querySelector('[aria-label="อัปไฟล์เสียง Akai Hana"]') as HTMLElement);
    fireEvent.change(rowInput(), { target: { files: [WRONG] } });
    await waitFor(() => expect(h.uploads).toHaveLength(1));
    expect(screen.queryByText(/แทนที่ไฟล์เสียงของ/)).toBeNull();
  });

  it("the edit dialog's บันทึก with a picked file asks before anything is written; ยกเลิก keeps the dialog and its pick", async () => {
    mount(withFile);
    fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /แก้ไข/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [WRONG] } });
    await waitFor(() => expect((within(dialog).getByLabelText("ความยาว (m:ss)") as HTMLInputElement).value).toBe("3:20"));
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    const prompt = await replacePrompt();
    expect(prompt.textContent).toContain("จะถูกแทนด้วย “other-song.wav”");
    fireEvent.click(within(prompt).getByRole("button", { name: "ยกเลิก" }));
    await settle();
    expect(h.writes).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    const still = screen.getByRole("dialog", { name: "Edit Song" });
    expect(within(still).getByRole("button", { name: "บันทึก" })).toBeEnabled();
    expect(within(still).getByText("other-song.wav")).toBeTruthy(); // the pick is still there
  });
});
