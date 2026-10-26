// 2026-10-27 hunt: the Edit Song dialog sends only the fields the user changed. language,
// category and notes were always sent, so a library open since the morning wrote its old
// note back over the one another device had saved since - a title fix erased it, unwarned.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
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
  tryQueueAudioUpload: async () => false, // the web: nothing to queue into
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  // venue wifi drops the 88 MB PUT
  uploadEventAudio: async () => {
    throw new Error("Failed to fetch");
  },
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: async () => 312, // the new take: 5:12
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            h.writes.push({ values });
            const row = {
              id: "s1",
              tenant_id: "t1",
              group_id: "g1",
              title: "Neon Lullaby",
              file_name: "take-1.wav",
              duration_seconds: 150,
              copyright_status: "cleared",
              audio_path: "t1/g1/songs/s1-old.wav",
              audio_name: "take-1.wav",
              ...values,
            };
            return Object.assign(Promise.resolve({ data: [{ id: "s1", copyright_status: "cleared" }], error: null }), {
              single: async () => ({ data: row, error: null }),
            });
          },
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { SongLibrary } from "@/components/song/song-library";

const song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  file_name: "take-1.wav",
  duration_seconds: 150, // the OLD take, 2:30, which is what still plays
  copyright_status: "cleared",
  audio_path: "t1/g1/songs/s1-old.wav",
  audio_name: "take-1.wav",
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
});
// This page loaded before another device (the band's phone) wrote a note on the song:
// the list on screen still says notes: null. The user here only fixes a typo in the title.
describe("an edit made on a page opened earlier", () => {
  it("does not send fields the user never touched (the other device's note survives)", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[{ ...song, title: "Neon Lulaby", notes: null } as Song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const phone = document.querySelector('[class~="md:hidden"].stack') as HTMLElement;
    fireEvent.click(within(phone).getByText("Neon Lulaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    fireEvent.change(within(dialog).getByLabelText("ชื่อเพลง *"), { target: { value: "Neon Lullaby" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(h.writes.some((w) => w.values.title === "Neon Lullaby")).toBe(true));
    const sent = h.writes.find((w) => w.values.title === "Neon Lullaby")!.values;
    // length / file name / ลิขสิทธิ์ are already left out when untouched (c4388cf);
    // the note, language and category are not, so the stale null overwrites the phone's note
    expect("notes" in sent).toBe(false);
  });
});
