// "บันทึก / อัปเดต" on คลังเพลง does not load anything.
//
// app/(app)/library/page.tsx puts ConfirmSavedBar under the list with the note
// "ปุ่มนี้ยืนยัน + โหลดข้อมูลล่าสุด"; the bar calls router.refresh(), which re-renders the
// server page and hands SongLibrary a NEW `initialSongs`. SongLibrary seeds
// `useState<Song[]>(initialSongs)` (song-library.tsx:270) and never looks at the prop again,
// so the list (and every audio_path the row actions and the cache GC act on) stays as it was
// when the page opened, while the LibraryCount beside the title does update.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: async () => new Blob(["x"]),
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
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));

import { SongLibrary } from "@/components/song/song-library";

const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];
const base = { tenant_id: "t1", group_id: "g1", duration_seconds: 200, copyright_status: "cleared" };
const before = [{ ...base, id: "s1", title: "Flare Up", audio_path: "t1/g1/songs/s1-old.wav" } as Song];
// what the server holds now: a member added a song from their phone
const after = [...before, { ...base, id: "s2", title: "Kakumei (new)", audio_path: "t1/g1/songs/s2-x.wav" } as Song];

describe("SongLibrary — router.refresh() brings the server's list", () => {
  it("shows a song that the refreshed page passes in", () => {
    const view = (songs: Song[]) => (
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={songs} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const { rerender } = render(view(before));
    rerender(view(after)); // what router.refresh() does to a client component's props
    expect(screen.queryAllByText("Kakumei (new)").length).toBeGreaterThan(0);
  });
});
