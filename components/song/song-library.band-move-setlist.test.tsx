// A song in a show's setlist may not change band (2026-10-27, hunt 9). The band move was
// refused only for a song WITH a file; one without (a title waiting for its master) moved
// freely while a show of the old band still listed it. The event page reads only its own
// band's songs, so the approver's copyright panel and the band's rejected-song warning
// lost it, while Overview's Rights tile kept counting it. Same rule as a show's own band
// move: a count that could not be read blocks, and so does an empty one read with no session.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  writes: [] as { values: Record<string, unknown> }[],
  usage: { data: [] as { event_id: string }[] | null, error: null as { message: string } | null },
  usageReads: [] as unknown[],
  session: true as boolean | null,
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
  listPendingAudioUploads: async () => new Set<string>(),
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
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  hasLiveSession: async () => h.session,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, v: unknown) => {
          h.usageReads.push(v);
          return Promise.resolve(table === "setlist_items" ? h.usage : { data: [], error: null });
        },
      }),
      update: (values: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            h.writes.push({ values });
            const one = { ...song, ...values };
            return Object.assign(Promise.resolve({ data: [{ id: song.id }], error: null }), {
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
  file_name: null,
  duration_seconds: 150,
  language: null,
  category: null,
  copyright_status: "pending",
  notes: null,
  audio_path: null,
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
  h.usageReads.length = 0;
  h.usage = { data: [], error: null };
  h.session = true;
  h.toast.error.mockReset();
  h.toast.success.mockReset();
});

async function moveToOtherBand() {
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
  fireEvent.change(band!, { target: { value: "g2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
}

describe("SongLibrary — moving a song a show's setlist holds", () => {
  it("is refused, saying how many shows hold it, and writes nothing", async () => {
    h.usage = { data: [{ event_id: "e1" }, { event_id: "e1" }, { event_id: "e2" }], error: null };
    await moveToOtherBand();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0][0]).toBe("ย้ายวงไม่ได้ ขณะเพลงนี้อยู่ในเซ็ตลิสต์");
    expect(h.toast.error.mock.calls[0][1].description).toContain("2 งาน");
    expect(h.usageReads).toContain("s1");
    expect(h.writes).toHaveLength(0);
  });

  it("is refused when the setlists could not be read", async () => {
    h.usage = { data: null, error: { message: "network" } };
    await moveToOtherBand();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0][0]).toBe("ย้ายวงไม่ได้ ขณะเพลงนี้อยู่ในเซ็ตลิสต์");
    expect(h.writes).toHaveLength(0);
  });

  it("is refused when 'used nowhere' came back with no session behind it", async () => {
    h.session = false;
    await moveToOtherBand();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.writes).toHaveLength(0);
  });

  it("goes through for a song no setlist holds", async () => {
    await moveToOtherBand();
    await waitFor(() => expect(h.writes).toHaveLength(1));
    expect(h.writes[0].values.group_id).toBe("g2");
    expect(h.toast.error).not.toHaveBeenCalled();
  });
});
