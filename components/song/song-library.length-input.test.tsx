// the library's ความยาว field.
//
// onSave sends `form.durationStr ? parseDurationToSeconds(form.durationStr) : 0`
// (components/song/song-library.tsx ~774). parseDurationToSeconds (lib/time.ts) reads a
// lone number as SECONDS and rounds it, so "3.30" — how a Thai user writes three and a half
// minutes (เวลา 3.30) — is saved as 3 seconds, with a green "บันทึกเพลงแล้ว". The setlist
// builder copies songs.duration_seconds into each new row (setlist-builder.tsx ~997), and
// Live's Auto runs a row for its duration_seconds (live-mode.tsx blockSeconds), so the song
// is cut at 0:03. Anything the parser rejects becomes `null` and goes to a NOT NULL column:
// the save fails with Postgres's English "null value in column …" message.
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
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            h.writes.push({ values });
            // the real column is `duration_seconds int not null` (0002_songs.sql)
            const bad = values.duration_seconds === null;
            const row = { id: "s1", tenant_id: "t1", group_id: "g1", copyright_status: "pending", ...values };
            return Object.assign(Promise.resolve({ data: [{ id: "s1" }], error: null }), {
              single: async () =>
                bad
                  ? { data: null, error: { message: 'null value in column "duration_seconds" of relation "songs" violates not-null constraint' } }
                  : { data: row, error: null },
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
  title: "Kakumei MC backing",
  file_name: null,
  duration_seconds: 0,
  copyright_status: "pending",
  audio_path: null,
} as unknown as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

async function saveLength(text: string) {
  render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
  const phone = document.querySelector(".stack.md\\:hidden") as HTMLElement;
  fireEvent.click(within(phone).getByText(song.title).closest("button[aria-haspopup=dialog]") as HTMLElement);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
  fireEvent.change(within(dialog).getByLabelText("ความยาว (m:ss)"), { target: { value: text } });
  fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
  await waitFor(() => expect(h.writes.length + h.toast.error.mock.calls.length).toBeGreaterThan(0));
}

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.toast.error.mockClear();
  h.toast.success.mockClear();
});

describe("SongLibrary — the length the user types", () => {
  it('"3.30" (three and a half minutes, Thai style) is not saved as 3 seconds', async () => {
    await saveLength("3.30");
    const written = h.writes.find((w) => "duration_seconds" in w.values)?.values.duration_seconds;
    // 210, or refused with a message — never a silent 0:03 that Auto will cut at.
    expect(written).not.toBe(3);
  });

  it("a length the parser rejects never reaches the NOT NULL column", async () => {
    await saveLength("3:3o");
    const written = h.writes.find((w) => "duration_seconds" in w.values);
    expect(written?.values.duration_seconds).not.toBeNull();
  });
});
