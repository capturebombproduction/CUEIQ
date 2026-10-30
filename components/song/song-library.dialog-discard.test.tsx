// 2026-10-30, hunt 10 (mistakes-5): the song add/edit dialog closed on a tap outside it, on Esc
// and on ยกเลิก with no word - typed title / notes and a picked file were simply gone (the in-app
// feedback of 2026-08-13 asked for "ยังไม่ได้บันทึก" before leaving). It now asks "ทิ้งที่แก้ไว้?"
// when the form differs from how it opened or a file is picked; an untouched dialog closes as before.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

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
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: () => Promise.resolve(200),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Akai Hana",
  duration_seconds: 228,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;

function mount() {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
}
async function openEdit() {
  fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /แก้ไข/ }));
  return screen.findByRole("dialog", { name: "Edit Song" });
}
// by its title text: while the prompt is up, Radix aria-hides the dialog under it, and a role
// query can no longer name it
const editDialog = () => (screen.queryByText("Edit Song")?.closest("[role=dialog]") as HTMLElement | null) ?? null;
const discardPrompt = () => screen.queryByText("ทิ้งที่แก้ไว้?");
const pressEsc = (el: HTMLElement) => fireEvent.keyDown(el, { key: "Escape" });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SongLibrary — the add/edit dialog does not drop work silently", () => {
  it("untouched: Esc closes it at once, nothing asked", async () => {
    mount();
    const dialog = await openEdit();
    pressEsc(dialog);
    await waitFor(() => expect(editDialog()).toBeNull());
    expect(discardPrompt()).toBeNull();
  });

  it("a typed change: Esc asks; แก้ต่อ keeps the dialog and the text, ทิ้ง closes it", async () => {
    mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Akai Hana (acoustic)" } });
    pressEsc(dialog);
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    expect(editDialog()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "แก้ต่อ" }));
    await settle();
    expect(discardPrompt()).toBeNull();
    expect((within(editDialog()!).getByLabelText("ชื่อเพลง *") as HTMLInputElement).value).toBe("Akai Hana (acoustic)");

    pressEsc(editDialog()!);
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "ทิ้ง" }));
    await waitFor(() => expect(editDialog()).toBeNull());
  });

  it("a tap on the dimmed page with a change asks too", async () => {
    mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Akai Hana (live)" } });
    // Radix waits for the click that follows a primary press outside before it dismisses
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.click(document.body);
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    expect(editDialog()).toBeTruthy();
  });

  it("ยกเลิก follows the same rule: untouched closes, changed asks", async () => {
    mount();
    let dialog = await openEdit();
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(editDialog()).toBeNull());
    expect(discardPrompt()).toBeNull();

    dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Akai Hana (v2)" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    expect(editDialog()).toBeTruthy();
  });

  it("a new song with only a file picked asks before dropping the file", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเพลง" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Song" });
    pressEsc(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Song" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเพลง" }));
    const again = await screen.findByRole("dialog", { name: "Add Song" });
    fireEvent.change(again.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["wav"], "new-song.wav", { type: "audio/wav" })] },
    });
    await waitFor(() => expect(within(again).getByText("new-song.wav")).toBeTruthy());
    pressEsc(again);
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    expect(screen.getByText(/ปิดแล้วที่กรอกไว้และไฟล์ที่เลือกไว้จะหายไป/)).toBeTruthy();
  });
});
