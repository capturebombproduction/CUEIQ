// Hunt 3 (2026-10-27), songs-2: the 19ea761 band-move guard covers a file ON the row and a
// file QUEUED on this desktop, but not a file whose upload is RUNNING on this device.
// An admin replaces/attaches a master (minutes on venue Wi-Fi), opens แก้ไข meanwhile,
// moves the song to another band: allowed - then the upload lands an audio_path minted
// under the OLD band (<t>/<oldBand>/songs/...), which presign refuses to the new band.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  release: null as null | (() => void),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: { value: string; onValueChange?: (v: string) => void; disabled?: boolean; children: ReactNode }) => (
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
  listPendingAudioUploads: async () => new Set<string>(),
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  // the 88 MB PUT is still on its way
  uploadEventAudio: () => new Promise<void>((res) => { h.release = res; }),
  removeEventAudio: async () => {},
}));
vi.mock("@/lib/realtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/realtime")>()),
  privateChannel: () => ({ subscribe() {}, send() {} }),
}));
vi.mock("@/lib/notify-client", () => ({ notify: () => {} }));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            h.writes.push({ values });
            const one = { id: "s1", tenant_id: "t1", group_id: "g1", title: "Neon Lullaby", duration_seconds: 150, copyright_status: "pending", audio_path: null, ...values };
            return Object.assign(Promise.resolve({ data: [{ id: "s1", copyright_status: "pending" }], error: null }), {
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

const song = {
  id: "s1", tenant_id: "t1", group_id: "g1", title: "Neon Lullaby", file_name: null,
  duration_seconds: 150, language: null, category: null, copyright_status: "pending", notes: null,
  audio_path: null, audio_name: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
} as unknown as Song;
const groups = [
  { id: "g1", tenant_id: "t1", name: "HatoBito" } as Group,
  { id: "g2", tenant_id: "t1", name: "Seishin Kakumei" } as Group,
];

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
});

describe("band move while this device is uploading the song's file", () => {
  it("is refused like a file on the row or a queued one", async () => {
    const { container } = render(
      <ConfirmProvider>
        <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
      </ConfirmProvider>
    );
    fireEvent.click(container.querySelector('[aria-label="อัปไฟล์เสียง Neon Lullaby"]') as HTMLElement);
    const input = container.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["wav"], "take-1.wav", { type: "audio/wav" })] } });
    await waitFor(() => expect(h.release).not.toBeNull()); // PUT in flight

    fireEvent.click(container.querySelector('[aria-label="แก้ไขเพลง Neon Lullaby"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Edit Song" });
    const band = [...dialog.querySelectorAll<HTMLSelectElement>("select[data-probe-select]")].find((s) =>
      [...s.options].some((o) => o.value === "g2")
    );
    fireEvent.change(band!, { target: { value: "g2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await new Promise((r) => setTimeout(r, 50));

    h.release?.(); // the PUT lands; its row update names the g1 key
    await waitFor(() => expect(h.writes.some((w) => typeof w.values.audio_path === "string")).toBe(true));
    const moved = h.writes.some((w) => w.values.group_id === "g2");
    const landedKey = h.writes.find((w) => typeof w.values.audio_path === "string")!.values.audio_path as string;
    // the song may not end up in g2 with a master keyed under g1
    expect(moved && landedKey.startsWith("t1/g1/")).toBe(false);
  });
});
