// คลังเพลง, Black Stage layout (spec §G.5). What is pinned here is what a phone
// user meets: a 62 px row whose tap opens the song's sheet (where edit, audio and
// delete now live), the 44 px ▶, the filter chips that replaced two dropdowns,
// and a row that survives a cached song with no rights field at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

// Round 15 (CQ-39 / CQ-40 / CQ-62). jsdom has no layout, so these pin the classes that
// make the layout work; the pixel proof is a real-browser measurement (the harness's
// lib-overflow probe at 768 / 810 / 820 / 834 / 844 and ev_libmeta at 360).
describe("SongLibrary — tablet table, phone meta line, chip row", () => {
  const FILE = "Seishin_Kakumei_FINAL_master_v3_2026-09-30_mix.mp3";
  const twoBands = [
    { id: "g1", tenant_id: "t1", name: "Seishin Kakumei", color: "#a62a1c" } as Group,
    { id: "g2", tenant_id: "t1", name: "Capture Bomb" } as Group,
  ];
  const mountBands = (songs: Song[], bands: Group[], perms: Perms) =>
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={bands} initialSongs={songs} perms={perms} />
      </ConfirmProvider>
    );
  const cls = (el: Element) => el.className.split(/\s+/);

  // CQ-39: a label admin's table (Song + Length + Audio + Rights + ▶ + manage + Band)
  // was ~886 px wide at 768, so edit / delete sat off-screen in a hint-less scroller.
  // 2026-10-04: from 1150 px, not lg - at 1024 the fixed columns left the Song column ~100 px
  it("the Band column is 1150 px-and-up only: below it is a meta line under the title", () => {
    mountBands(
      [song("s1", "Akai Hana", { group_id: "g2", file_name: FILE })],
      twoBands,
      makePerms("admin")
    );
    const head = screen.getByRole("columnheader", { name: "Band" });
    expect(cls(head)).toEqual(expect.arrayContaining(["hidden", "[@media(min-width:1150px)]:table-cell"]));
    // and Language with it
    expect(cls(screen.getByRole("columnheader", { name: "Language" }))).toEqual(
      expect.arrayContaining(["hidden", "[@media(min-width:1150px)]:table-cell"])
    );

    const row = screen.getAllByRole("row")[1];
    const cells = within(row).getAllByRole("cell");
    // the Band cell is the one holding the band name and nothing else
    const bandCell = cells.find((c) => c.textContent === "Capture Bomb")!;
    expect(cls(bandCell)).toEqual(expect.arrayContaining(["hidden", "[@media(min-width:1150px)]:table-cell"]));

    // the same name, as a muted line in the Song cell, shown only below lg
    const meta = within(cells[0]).getByText("Capture Bomb").parentElement!;
    expect(cls(meta)).toContain("[@media(min-width:1150px)]:hidden");
    expect(cls(meta)).not.toContain("hidden");
    expect(cls(meta)).toContain("text-muted-foreground");
  });

  it("a one-band library has neither a Band column nor the meta line", () => {
    mountBands([song("s1", "Akai Hana")], [twoBands[0]], makePerms("admin"));
    expect(screen.queryByRole("columnheader", { name: "Band" })).toBeNull();
    const row = screen.getAllByRole("row")[1];
    expect(within(row).queryByText("Seishin Kakumei")).toBeNull();
  });

  it("the file name wraps anywhere instead of holding the Song column open", () => {
    mountBands([song("s1", "Akai Hana", { file_name: FILE })], twoBands, makePerms("admin"));
    const name = within(screen.getAllByRole("row")[1]).getByText(FILE);
    expect(cls(name)).toEqual(expect.arrayContaining(["min-w-0", "break-all"]));
    // two lines at most, the whole name on hover
    expect(cls(name)).toContain("line-clamp-2");
    expect(name.getAttribute("title")).toBe(FILE);
  });

  it("Length and Audio are narrower below lg (Audio below 1150 px), so the Song column keeps its room", () => {
    mountBands([song("s1", "Akai Hana")], twoBands, makePerms("admin"));
    expect(cls(screen.getByRole("columnheader", { name: "Length" }))).toEqual(
      expect.arrayContaining(["w-20", "lg:w-24"])
    );
    expect(cls(screen.getByRole("columnheader", { name: "Audio" }))).toEqual(
      expect.arrayContaining(["w-32", "[@media(min-width:1150px)]:w-[10rem]"])
    );
  });

  // CQ-40: text-overflow does not apply to flex items, so the phone meta line (a `flex`
  // with `truncate`) hard-clipped "174 BPM" to "174 BP" at 360 with no ellipsis.
  it("the phone meta line is a block that truncates — never a flex row", () => {
    mount([song("s1", "Seishin Kakumei", { language: "jp", bpm: 174 })]);
    const row = phoneList().children[0] as HTMLElement;
    const meta = [...row.querySelectorAll("span.truncate")].find((el) => /BPM/.test(el.textContent ?? ""))!;
    expect(meta).toBeTruthy();
    expect(cls(meta)).toEqual(expect.arrayContaining(["block", "truncate"]));
    expect(cls(meta)).not.toContain("flex");
    // the separators carry their own margin now (there is no flex gap), tighter under 380 px
    const dots = [...meta.querySelectorAll("span[aria-hidden]")];
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.textContent).toBe("·");
      expect(cls(dot)).toEqual(expect.arrayContaining(["mx-1.5", "[@media(max-width:380px)]:mx-0.5"]));
    }
    // length · language · BPM still read in order
    expect(meta.textContent).toBe("3:48·ญี่ปุ่น·174 BPM");
  });

  // R15 final verification. At 360 the line's box is 122-126 px and "length · language ·
  // BPM" with the old 4 px separators was 125 px for a Japanese row and 135 for an English
  // one — "BPM" read "B…". Real browser, 360, 20 library rows: 12 were cut (max 13 px
  // over); with these three tightenings none are (widest line 122 px in 126); at 375 / 390
  // / 430 the line measures what it did. jsdom has no layout, so this pins the classes.
  it("under 380 px the BPM unit and the row's gap tighten with the separators, and not above", () => {
    mount([song("s1", "Seishin Kakumei", { language: "jp", bpm: 174 })]);
    const row = phoneList().children[0] as HTMLElement;
    const meta = [...row.querySelectorAll("span.truncate")].find((el) => /BPM/.test(el.textContent ?? ""))!;
    // the unit word is its own span so it can shrink; the numeral beside it keeps 15 px
    const unit = [...meta.querySelectorAll("span")].find((el) => el.textContent === "BPM")!;
    expect(unit).toBeTruthy();
    expect(cls(unit)).toContain("[@media(max-width:380px)]:text-[10px]");
    // every tightening is under the media query: nothing narrows the line at 390 and up
    expect(cls(unit).filter((c) => /^text-/.test(c))).toEqual([]);
    expect(cls(row)).toEqual(expect.arrayContaining(["gap-2", "[@media(max-width:380px)]:gap-1.5"]));
    const number = [...meta.querySelectorAll("span.num")].find((el) => el.textContent === "174")!;
    expect(cls(number)).toContain("text-[15px]");
  });

  // CQ-62: no autoprefixer, so `[scrollbar-width:none]` alone leaves chip-row scrollbars
  // on Mac Safari < 18.2. `.no-scrollbar` (app/globals.css) carries both rules.
  it("the chip row hides its scrollbar with .no-scrollbar, not the bare arbitrary property", () => {
    mount([song("s1", "Akai Hana")]);
    const chips = screen.getByRole("button", { name: "ทั้งหมด" }).parentElement!;
    expect(cls(chips)).toContain("no-scrollbar");
    expect(cls(chips)).toContain("overflow-x-auto");
    expect(cls(chips)).not.toContain("[scrollbar-width:none]");
    const src = fs.readFileSync(path.resolve(__dirname, "song-library.tsx"), "utf8");
    expect(src).not.toContain("[scrollbar-width:none]");
  });
});

describe("SongLibrary — the Add Song dialog with a real master's file name", () => {
  // Found adding Seishin's 36 masters through the app (2026-10-03): the picked file's name
  // sat in a flex row without min-w-0, so it never truncated; the dialog scrolled sideways
  // and the language field and the save button slid out of view. jsdom has no layout, so the
  // contract that prevents it is pinned instead: the name may shrink, the button may not.
  it("the file name can shrink and truncate (min-w-0), the button keeps its size, the full name is the title", () => {
    mount([], makePerms("admin"));
    fireEvent.click(screen.getAllByRole("button", { name: /เพิ่มเพลง/ })[0]);
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByTestId("song-file-name");
    const cls = name.className.split(" ");
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("truncate");
    expect(within(dialog).getByRole("button", { name: /เลือกไฟล์/ }).className.split(" ")).toContain("shrink-0");

    const long = "LIVE - Intoxicated Mirage of Riko 【リコの酔いしれた蜃気楼】 (Riko no Yoishireta Shinkirō) - Seishin Kakumei.wav";
    const input = dialog.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], long, { type: "audio/wav" })] } });
    expect(name.textContent).toBe(long);
    expect(name.getAttribute("title")).toBe(long);
  });
});
