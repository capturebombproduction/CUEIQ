// 2026-10-27 hunt: a file still QUEUED on this desktop counts too. Moving a song that HAS a file to another band in the edit dialog
// is refused: its R2 master would stay under the OLD band's prefix.
//
// The edit dialog offers a "วง" select whenever the editor has more than one band (an admin
// always does), and onSave used to write `group_id` with no thought for the file. The master's key
// is `<tenant>/<band>/songs/<song>-<rand>.<ext>`, and /api/audio/presign authorises a GET of a
// band-scoped key with can_view_group(<band IN THE KEY>) (lib/presign-authz.ts). So after the
// move, every band-tier account of the NEW band (seishin-ar / seishin-mem — the show laptop)
// is refused the file (403) while the admin who made the move still hears it everywhere.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const ORIGINAL_PATH = "t1/g1/songs/s1-aaaaaaaa.wav";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown>; eqs: [string, unknown][] }[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Radix Select cannot be driven in jsdom; a native <select> with the same contract.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select data-probe-select value={value} disabled={disabled} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{typeof children === "string" ? children : value}</option>
  ),
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
  listPendingAudioUploads: async () => new Set<string>(["s1"]), // a file picked offline, still queued (desktop)
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  uploadEventAudio: async () => {},
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const eqs: [string, unknown][] = [];
        const chain = {
          eq(col: string, v: unknown) {
            eqs.push([col, v]);
            return chain;
          },
          select: () => {
            h.writes.push({ values, eqs });
            const id = eqs.find(([c]) => c === "id")?.[1];
            const one = {
              id,
              tenant_id: "t1",
              group_id: "g1",
              title: "Neon Lullaby",
              duration_seconds: 150,
              copyright_status: "cleared",
              audio_path: ORIGINAL_PATH,
              audio_name: "take-1.wav",
              ...values,
            };
            return Object.assign(Promise.resolve({ data: [{ id }], error: null }), {
              single: async () => ({ data: one, error: null }),
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

const song: Song = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Neon Lullaby",
  file_name: "take-1.wav",
  duration_seconds: 150,
  language: null,
  category: null,
  copyright_status: "cleared",
  notes: null,
  audio_path: null, // no master yet: its only file is the queued one
  audio_name: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const groups = [
  { id: "g1", tenant_id: "t1", name: "HatoBito" } as Group,
  { id: "g2", tenant_id: "t1", name: "Seishin Kakumei" } as Group,
];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
});

describe("band move while an upload is queued", () => {
  it("does not leave the master under the old band's R2 prefix", async () => {
    render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    const phone = document.querySelector(".stack.md\\:hidden") as HTMLElement;
    fireEvent.click(within(phone).getByText("Neon Lullaby").closest("button[aria-haspopup=dialog]") as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    const band = [...dialog.querySelectorAll<HTMLSelectElement>("select[data-probe-select]")].find((s) =>
      [...s.options].some((o) => o.value === "g2")
    );
    fireEvent.change(band!, { target: { value: "g2" } }); // the song was filed under the wrong band
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    // refused with a reason, nothing written: the key would stay under g1 while the
    // song said g2, and presign answers 403 to g2's own accounts
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    
    expect(h.writes).toHaveLength(0);
  });
});
