// The usage read before "แทนที่ไฟล์เสียง…?" / "ลบไฟล์เสียง…?" on a slow venue link (2026-10-30,
// hunt 11). Hunt 10 put that read in front of both questions, with nothing on screen while it
// ran and no timeout: on slow Wi-Fi a picked file looked ignored and ⬆ / 🗑 stayed live; on a
// link that never answers the question never came. A second pick then had its question answered
// "cancelled" unseen behind the first (useConfirm's one dialog). Now the row reads "กำลังตรวจ…"
// from the pick on, a second file job on that song is refused out loud, and the read gives way
// after 8 s to the "ตรวจไม่ได้" wording the questions already have.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  // the usage read (setlist_items) waits on this while it is set - a slow venue link
  hold: null as null | Promise<void>,
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
      const gate = table === "setlist_items" && h.hold ? h.hold : Promise.resolve();
      return gate.then(() => result).then(res, rej);
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

import { toast } from "sonner";
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
const RIGHT = new File(["wav"], "akai-hana-v2.wav", { type: "audio/wav" });
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
  h.hold = null;
  vi.mocked(toast.info).mockClear();
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.uploads.length = 0;
  h.removed.length = 0;
});

const checking = () => screen.queryAllByText("กำลังตรวจ…").length > 0;
const tableUpload = (c: HTMLElement) =>
  c.querySelector('[aria-label="เปลี่ยนไฟล์เสียง Akai Hana"]') as HTMLButtonElement | null;
function holdUsageRead() {
  let release!: () => void;
  h.hold = new Promise<void>((r) => (release = r));
  return () => release();
}

describe("SongLibrary — the usage read before a file question, on a slow link", () => {
  it("a pick shows the row busy at once; the question follows the read; ยกเลิก frees the row", async () => {
    const release = holdUsageRead();
    const { container } = mount(withFile);
    fireEvent.click(tableUpload(container)!);
    fireEvent.change(rowInput(), { target: { files: [WRONG] } });
    await settle();
    expect(checking()).toBe(true);
    expect(tableUpload(container)!.disabled).toBe(true);
    expect(screen.queryByText(/แทนที่ไฟล์เสียงของ/)).toBeNull();

    release();
    const prompt = await replacePrompt();
    fireEvent.click(within(prompt).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(checking()).toBe(false));
    expect(tableUpload(container)!.disabled).toBe(false);
    expect(h.uploads).toHaveLength(0);
  });

  it("a second pick while the first waits is refused out loud; the question names the FIRST file", async () => {
    const release = holdUsageRead();
    const { container } = mount(withFile);
    fireEvent.click(tableUpload(container)!);
    fireEvent.change(rowInput(), { target: { files: [WRONG] } });
    await settle();
    fireEvent.change(rowInput(), { target: { files: [RIGHT] } });
    await settle();
    expect(toast.info).toHaveBeenCalledTimes(1);

    release();
    const prompt = await replacePrompt();
    expect(prompt.textContent).toContain("จะถูกแทนด้วย “other-song.wav”");
    fireEvent.click(within(prompt).getByRole("button", { name: "แทนที่ไฟล์" }));
    await waitFor(() => expect(h.uploads).toHaveLength(1));
  });

  it("a read that never answers gives way to the 'ตรวจไม่ได้' question", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.hold = new Promise<void>(() => {}); // never
      const { container } = mount(withFile);
      fireEvent.click(tableUpload(container)!);
      fireEvent.change(rowInput(), { target: { files: [WRONG] } });
      await vi.advanceTimersByTimeAsync(8_100);
      const prompt = await replacePrompt();
      expect(prompt.textContent).toContain("ตรวจไม่ได้ว่าเพลงนี้ใช้อยู่ในงานหรือห้องซ้อมไหนบ้าง (เน็ตขัดข้อง)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ลบไฟล์เสียง: busy while the read runs, free again after ยกเลิก", async () => {
    const release = holdUsageRead();
    mount(withFile);
    fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("ลบไฟล์เสียง"));
    await settle();
    expect(checking()).toBe(true);
    expect(screen.queryByText(/ลบไฟล์เสียงของ “Akai Hana”/)).toBeNull();

    release();
    const prompt = (await screen.findByText(/ลบไฟล์เสียงของ “Akai Hana”/)).closest("[role=dialog]") as HTMLElement;
    fireEvent.click(within(prompt).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(checking()).toBe(false));
    expect(h.writes).toHaveLength(0);
  });
});
