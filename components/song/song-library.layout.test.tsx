// คลังเพลง, Black Stage layout (spec §G.5). What is pinned here is what a phone
// user meets: a 62 px row whose tap opens the song's sheet (where edit, audio and
// delete now live), the 44 px ▶, the filter chips that replaced two dropdowns,
// and a row that survives a cached song with no rights field at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms, type Perms } from "@/lib/permissions";
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
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "./song-library";

const song = (id: string, title: string, extra: Partial<Song> = {}): Song =>
  ({
    id,
    tenant_id: "t1",
    group_id: "g1",
    title,
    duration_seconds: 228,
    copyright_status: "cleared",
    audio_path: `t1/g1/songs/${id}.wav`,
    ...extra,
  }) as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

function mount(songs: Song[], perms: Perms = makePerms(null)) {
  return render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={songs} perms={perms} />
    </ConfirmProvider>
  );
}

/** The phone list (md:hidden) — jsdom has no CSS, so both layouts render. */
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
const phoneTitles = () =>
  [...phoneList().querySelectorAll("button[aria-haspopup=dialog] > span.min-w-0 > span:first-child")].map(
    (el) => el.textContent
  );

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SongLibrary — Black Stage layout", () => {
  it("a cached song with no rights field renders as รอตรวจ instead of taking the page down", () => {
    const legacy = song("s1", "Neon Lullaby", { copyright_status: undefined as never });
    mount([legacy]);
    expect(within(phoneList()).getByText("รอตรวจ")).toBeTruthy();
  });

  it("phone rows carry cover, title and length · language · BPM, and a 44 × 44 ▶ only where there is a file", () => {
    mount([
      song("s1", "Seishin Kakumei", { language: "jp", bpm: 174 }),
      song("s2", "No File Yet", { audio_path: null }),
    ]);
    const row = phoneList().children[0] as HTMLElement;
    expect(row.textContent).toContain("3:48");
    expect(row.textContent).toContain("ญี่ปุ่น");
    expect(row.textContent).toContain("174");
    const play = within(row).getByRole("button", { name: "เล่นตัวอย่าง Seishin Kakumei" });
    expect(play.className).toMatch(/\bh-11\b/);
    expect(play.className).toMatch(/\bw-11\b/);
    const noFile = phoneList().children[1] as HTMLElement;
    expect(within(noFile).queryByRole("button", { name: /ตัวอย่าง/ })).toBeNull();
  });

  it("tapping a phone row opens its sheet: notes, rights, audio — and edit + delete for an editor", () => {
    mount([song("s1", "Akai Hana", { notes: "คีย์ต่ำลง 2" })], makePerms("admin"));
    fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Akai Hana" })).toBeTruthy();
    expect(within(sheet).getByText("คีย์ต่ำลง 2")).toBeTruthy();
    expect(within(sheet).getByText("มีไฟล์")).toBeTruthy();
    // replacing / removing just the file lives here (the table's Audio column is one line)
    expect(within(sheet).getByTitle("เปลี่ยนไฟล์เสียง")).toBeTruthy();
    expect(within(sheet).getByTitle("ลบไฟล์เสียง")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /แก้ไข/ })).toBeTruthy();
    const del = within(sheet).getByRole("button", { name: /ลบเพลง/ });
    // a delete outside the confirm sheet is the dashed outline, never a red fill
    expect(del.className).toMatch(/border-dashed/);
  });

  it("an approver's phone row shows rights as a chip only; the cycle control lives in the sheet and the table", () => {
    // one tap in the row writes copyright_status and notifies people, and the row's
    // ▶ sits right beside it — so on a phone the change is made in the sheet
    mount([song("s1", "Akai Hana", { copyright_status: "pending" })], makePerms("admin"));
    const row = phoneList().children[0] as HTMLElement;
    expect(within(row).getByText("รอตรวจ")).toBeTruthy();
    expect(within(row).queryByTitle(/เปลี่ยนสถานะลิขสิทธิ์/)).toBeNull();
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      expect.stringContaining("Akai Hana"),
      "เล่นตัวอย่าง Akai Hana",
    ]);
    // the md+ table row keeps its control
    expect(within(screen.getAllByRole("row")[1]).getByTitle(/เปลี่ยนสถานะลิขสิทธิ์/)).toBeTruthy();
    // and so does the song's sheet
    fireEvent.click(within(row).getByRole("button", { name: /^Akai Hana/ }));
    expect(within(screen.getByRole("dialog")).getByTitle(/เปลี่ยนสถานะลิขสิทธิ์/)).toBeTruthy();
  });

  it("a member's sheet shows the song but no edit or delete", () => {
    mount([song("s1", "Akai Hana")]);
    fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: /แก้ไข/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /ลบเพลง/ })).toBeNull();
  });

  it("filter chips: รอตรวจ n shows the pending songs, มีเสียง the ones with a file, ทั้งหมด clears", () => {
    mount([
      song("s1", "Cleared With File"),
      song("s2", "Pending With File", { copyright_status: "pending" }),
      song("s3", "Pending No File", { copyright_status: "pending", audio_path: null }),
    ]);
    const pending = screen.getByRole("button", { name: /รอตรวจ\s*2/ });
    expect(pending.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pending);
    expect(pending.getAttribute("aria-pressed")).toBe("true");
    expect(phoneTitles()).toEqual(["Pending With File", "Pending No File"]);

    fireEvent.click(screen.getByRole("button", { name: /มีเสียง/ }));
    expect(phoneTitles()).toEqual(["Pending With File"]);

    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));
    expect(phoneTitles()).toEqual(["Cleared With File", "Pending With File", "Pending No File"]);
    expect(screen.getByRole("button", { name: "ทั้งหมด" }).getAttribute("aria-pressed")).toBe("true");
  });

  // The rights dropdown these chips replaced offered ✅ ถูกต้อง too: an approver
  // re-checking a clearance made by mistake narrows the library to the cleared songs.
  it("filter chips: ถูกต้อง n shows only the cleared songs, and pressing it again clears it", () => {
    mount([
      song("s1", "Cleared One"),
      song("s2", "Pending One", { copyright_status: "pending" }),
      song("s3", "Rejected One", { copyright_status: "rejected" }),
      song("s4", "Cleared Two"),
    ]);
    const cleared = screen.getByRole("button", { name: /^ถูกต้อง\s*2$/ });
    expect(cleared.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(cleared);
    expect(cleared.getAttribute("aria-pressed")).toBe("true");
    expect(phoneTitles()).toEqual(["Cleared One", "Cleared Two"]);

    fireEvent.click(cleared);
    expect(cleared.getAttribute("aria-pressed")).toBe("false");
    expect(phoneTitles()).toHaveLength(4);
  });

  it("table headings are English chrome", () => {
    mount([song("s1", "Akai Hana")]);
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(["Song", "Length", "Audio", "Language", "Category", "Rights"]));
  });

  it("on the table the title opens the same sheet, and the row's actions are upload, edit, delete", () => {
    mount([song("s1", "Akai Hana")], makePerms("admin"));
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByRole("button", { name: "เปลี่ยนไฟล์เสียง Akai Hana" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "แก้ไขเพลง Akai Hana" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "ลบเพลง Akai Hana" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Akai Hana" }));
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Akai Hana" })).toBeTruthy();
  });
});
