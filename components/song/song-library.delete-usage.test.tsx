// deleting a song when the "is it used?" read fails.
//
// onDelete (components/song/song-library.tsx ~831) counts the setlist rows that use the song
// and warns "เพลงนี้ถูกใช้อยู่ใน N รายการของงาน — ลบแล้วงานพวกนั้นจะไม่มีไฟล์เพลงนี้".
// The count read's error is never looked at: `const { count } = …; const used = count ?? 0;`
// so a failed read (a venue wifi blip) asks the plain "ลบเพลง?" with no warning, exactly as
// for an unused song — and confirming deletes the row (setlist rows lose song_id) and the R2
// master for good. A failed read is not "used nowhere".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

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
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      // the usage count: the request never got an answer
      select: () => ({
        eq: async () => ({ data: null, count: null, error: { message: "TypeError: Failed to fetch" }, status: 0 }),
      }),
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Flare Up",
  duration_seconds: 210,
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-aaaaaaaa.wav",
} as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.toast.error.mockClear();
});

describe("SongLibrary — delete when the usage read failed", () => {
  it("does not offer the plain no-warning delete", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "ลบเพลง Flare Up" }));
    // either the delete is refused with an error, or the dialog says it could not check
    await waitFor(() =>
      expect(h.toast.error.mock.calls.length > 0 || !!screen.queryByText(/ลบเพลง “Flare Up” ออกจากคลัง/)).toBe(true)
    );
    if (h.toast.error.mock.calls.length > 0) return;
    const dialog = screen.getByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text.replace(/ลบเพลง “Flare Up” ออกจากคลัง\?|ลบเพลง|ยกเลิก|Close/g, "").trim().length).toBeGreaterThan(0);
  });
});
