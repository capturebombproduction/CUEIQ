// 2026-10-30, hunt 10 (mistakes-1): "ลบไฟล์เสียง" in a song's sheet - the trash icon right beside
// "เปลี่ยนไฟล์เสียง" - asked only "ข้อมูลเพลงยังอยู่ — ลบเฉพาะไฟล์เสียง", then deleted the R2 master
// for good. Every setlist row linked to the song (audio_path NULL = the song's master plays) went
// silent: the same loss onDelete warns about, read from nowhere. songUsage now feeds both prompts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  tables: [] as string[],
  usage: { count: 2 as number | null, error: null as unknown },
  rooms: [] as { event_id: string }[],
  writes: [] as { table: string; values: Record<string, unknown> }[],
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
  removeEventAudio: async (key: string) => {
    h.removed.push(key);
  },
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
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
          ? { data: null, count: h.usage.count, error: h.usage.error, status: 200 }
          : table === "practice_songs"
            ? { data: h.rooms, error: null, status: 200 }
            : table === "songs" && values
              ? { data: [{ id: "s1" }], error: null, status: 200 }
              : { data: [], error: null, status: 200 };
      return Promise.resolve(result).then(res, rej);
    };
    return c;
  };
  return {
    createClient: () => ({
      from: (t: string) => {
        h.tables.push(t);
        return chain(t);
      },
      removeChannel() {},
      auth: { getSession: async () => ({ data: { session: { access_token: "x" } }, error: null }) },
    }),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Akai Hana",
  duration_seconds: 228,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-aaaaaaaa.wav",
} as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  h.tables.length = 0;
  h.writes.length = 0;
  h.removed.length = 0;
  h.usage = { count: 2, error: null };
  h.rooms = [];
});

async function askToRemoveFile() {
  render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
  fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByTitle("ลบไฟล์เสียง"));
  const title = await screen.findByText(/ลบไฟล์เสียงของ “Akai Hana”/);
  return title.closest("[role=dialog]") as HTMLElement;
}

describe("SongLibrary — ลบไฟล์เสียง says where the song is used", () => {
  it("a song in two setlist rows and a practice room: names them, and says it cannot be undone", async () => {
    h.rooms = [{ event_id: "room-1" }];
    const prompt = await askToRemoveFile();
    expect(h.tables).toEqual(expect.arrayContaining(["setlist_items", "practice_songs"]));
    const text = prompt.textContent ?? "";
    expect(text).toContain("2 รายการของงาน");
    expect(text).toContain("ห้องซ้อม 1 ห้อง");
    expect(text).toContain("จะไม่มีเสียงเพลงนี้");
    expect(text).toContain("กู้คืนไม่ได้");
    expect(text).not.toContain("ข้อมูลเพลงยังอยู่");
  });

  it("a read that failed is said as such, never as 'used nowhere'", async () => {
    h.usage = { count: null, error: { message: "TypeError: Failed to fetch" } };
    const prompt = await askToRemoveFile();
    expect(prompt.textContent).toContain("ตรวจไม่ได้ว่าเพลงนี้ถูกใช้ในงานหรือห้องซ้อมไหนอยู่บ้าง");
  });

  it("a song used nowhere: still says the file goes for good", async () => {
    h.usage = { count: 0, error: null };
    const prompt = await askToRemoveFile();
    expect(prompt.textContent).toContain("ไฟล์จะถูกลบถาวร กู้คืนไม่ได้");
  });

  it("ยกเลิก removes nothing; ลบไฟล์เสียง still removes the file", async () => {
    let prompt = await askToRemoveFile();
    fireEvent.click(within(prompt).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(screen.queryByText(/ลบไฟล์เสียงของ “Akai Hana”/)).toBeNull());
    expect(h.writes).toHaveLength(0);
    expect(h.removed).toHaveLength(0);

    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("ลบไฟล์เสียง"));
    prompt = (await screen.findByText(/ลบไฟล์เสียงของ “Akai Hana”/)).closest("[role=dialog]") as HTMLElement;
    fireEvent.click(within(prompt).getByRole("button", { name: "ลบไฟล์เสียง" }));
    await waitFor(() => expect(h.removed).toEqual(["t1/g1/songs/s1-aaaaaaaa.wav"]));
    expect(h.writes).toEqual([
      { table: "songs", values: { audio_path: null, audio_name: null, file_name: null, audio_expires_at: null } },
    ]);
  });
});
