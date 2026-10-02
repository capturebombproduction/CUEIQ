// Song cover art (0044, พี่ 2026-10-03: "อยากใส่ปกเพลง … เป็น icon เสริมอีกทาง"). A cover
// replaces the generic tile in every row, an editor puts one on (or takes it off) from the
// song's sheet, and the write follows lib/write-guard.ts: a write that touched no row did
// not happen. The picture processing itself is lib/song-cover.ts's (no canvas in jsdom).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms, type Perms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const COVER = "data:image/webp;base64,UklGRg==";
const h = vi.hoisted(() => ({
  updates: [] as { values: Record<string, unknown>; id: string }[],
  rows: [{ id: "s1" }] as { id: string }[] | null,
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
vi.mock("@/lib/song-cover", () => ({ makeCoverDataUrl: async () => COVER }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => ({
          select: async () => {
            h.updates.push({ values, id });
            return { data: h.rows, error: null };
          },
        }),
      }),
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "./song-library";

const song = (id: string, title: string, extra: Partial<Song> = {}): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 228, copyright_status: "cleared", audio_path: null, ...extra }) as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];
const editor = makePerms("admin");

function mount(songs: Song[], perms: Perms = editor) {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={songs} perms={perms} />
    </ConfirmProvider>
  );
}
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
const openSheet = (title: string) =>
  fireEvent.click(within(phoneList()).getByText(title).closest("button[aria-haspopup=dialog]") as HTMLElement);

beforeEach(() => {
  document.body.innerHTML = "";
  h.updates.length = 0;
  h.rows = [{ id: "s1" }];
  h.toast.error.mockClear();
  h.toast.success.mockClear();
});

describe("SongLibrary — song covers", () => {
  it("a song's cover replaces the generic tile in its row; a song without one keeps the tile", () => {
    mount([song("s1", "Neon Lullaby", { cover: COVER }), song("s2", "No Cover")]);
    const rows = phoneList().children;
    expect((rows[0] as HTMLElement).querySelector(`img[src="${COVER}"]`)).not.toBeNull();
    expect((rows[1] as HTMLElement).querySelector("img")).toBeNull();
  });

  it("an editor puts a cover on from the sheet: the picture is written to the song and shown at once", async () => {
    mount([song("s1", "Neon Lullaby")]);
    openSheet("Neon Lullaby");
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("button", { name: /ใส่ปกเพลง/ })).toBeTruthy();
    const input = within(sheet).getByLabelText("เลือกรูปปกเพลง") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["png"], "cover.png", { type: "image/png" })] } });
    await waitFor(() => expect(h.updates).toEqual([{ values: { cover: COVER }, id: "s1" }]));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByAltText("ปกเพลง Neon Lullaby")).toBeTruthy());
    expect((phoneList().children[0] as HTMLElement).querySelector(`img[src="${COVER}"]`)).not.toBeNull();
    expect(h.toast.success).toHaveBeenCalledWith("ใส่ปกเพลงแล้ว");
  });

  it("a write that touched no row did not happen: no cover is shown and the user is told", async () => {
    h.rows = [];
    mount([song("s1", "Neon Lullaby")]);
    openSheet("Neon Lullaby");
    const input = within(screen.getByRole("dialog")).getByLabelText("เลือกรูปปกเพลง") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["png"], "cover.png", { type: "image/png" })] } });
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0][0]).toBe("ใส่ปกไม่สำเร็จ");
    expect((phoneList().children[0] as HTMLElement).querySelector("img")).toBeNull();
  });

  it("removing a cover asks first, then clears it", async () => {
    mount([song("s1", "Neon Lullaby", { cover: COVER })]);
    openSheet("Neon Lullaby");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /ลบปก/ }));
    fireEvent.click(await screen.findByRole("button", { name: "ลบปก" }));
    await waitFor(() => expect(h.updates).toEqual([{ values: { cover: null }, id: "s1" }]));
  });

  it("someone who cannot edit the band sees the cover but no buttons", () => {
    mount([song("s1", "Neon Lullaby", { cover: COVER })], makePerms(null));
    openSheet("Neon Lullaby");
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByAltText("ปกเพลง Neon Lullaby")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /ปก/ })).toBeNull();
  });
});
