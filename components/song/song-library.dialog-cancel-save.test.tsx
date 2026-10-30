// 2026-10-30, ตาที่ 3 on hunt 10: the add/edit dialog's close rule (requestCloseDialog) let a
// "running" save go on - but บันทึก sets `saving` BEFORE its reads (songBandMoveBlocker, then the
// replace prompt's usage read). A ยกเลิก / Esc in that window closed with no "ทิ้งที่แก้ไว้?", and
// then either nothing was saved (a refused move, a declined replace: form and file gone) or the
// "แทนที่ไฟล์เสียงของ …?" prompt came up over the closed dialog and its yes uploaded. A close
// before the first write now CANCELS the save; once the writes have started it still goes on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

const h = vi.hoisted(() => ({
  writes: [] as { table: string; values: Record<string, unknown> }[],
  uploads: [] as string[],
  holds: {} as Record<string, Promise<void> | undefined>, // a table whose reads wait
  uploadHold: undefined as Promise<void> | undefined,
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
  uploadEventAudio: async (path: string) => {
    await h.uploadHold;
    h.uploads.push(path);
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
  detectAudioDuration: () => Promise.resolve(200),
  audioOpenProblem: () => Promise.resolve(null),
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));
// Radix Select cannot be driven in jsdom: a native <select> with the same contract
vi.mock("@/components/ui/select", () => {
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select data-select value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    );
  }
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Nothing = () => null;
  const SelectItem = ({ value }: { value: string }) => <option value={value}>{value}</option>;
  return { Select, SelectTrigger: Nothing, SelectValue: Nothing, SelectContent: Pass, SelectItem, SelectGroup: Pass };
});
vi.mock("@/lib/supabase/client", () => {
  const chain = (table: string): unknown => {
    let values: Record<string, unknown> | null = null;
    let single = false;
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "maybeSingle"]) c[m] = () => c;
    c.single = () => {
      single = true;
      return c;
    };
    c.update = (v: Record<string, unknown>) => {
      values = v;
      return c;
    };
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(values ? undefined : h.holds[table])
        .then(() => {
          if (values) h.writes.push({ table, values });
          if (table === "setlist_items") return { data: [], count: 0, error: null, status: 200 };
          if (table === "songs" && values)
            return single
              ? { data: { id: "s1", tenant_id: "t1", group_id: "g1", title: "Akai Hana", ...values }, error: null }
              : { data: [{ id: "s1", copyright_status: "cleared" }], error: null, status: 200 };
          return { data: [], error: null, status: 200 };
        })
        .then(res, rej);
    return c;
  };
  return {
    createClient: () => ({
      from: (t: string) => chain(t),
      removeChannel() {},
      auth: { getSession: async () => ({ data: { session: { access_token: "x" } }, error: null }) },
    }),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "@/components/song/song-library";
import { toast } from "sonner";

const base = {
  id: "s1",
  tenant_id: "t1",
  group_id: "g1",
  title: "Akai Hana",
  duration_seconds: 228,
  copyright_status: "cleared",
} as unknown as Song;
const withFile = { ...base, audio_path: "t1/g1/songs/s1-old.wav", audio_name: "take-1.wav" } as unknown as Song;
const groups = [
  { id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group,
  { id: "g2", tenant_id: "t1", name: "Other Band" } as Group,
];
const phoneList = () => document.querySelector(".stack.md\\:hidden") as HTMLElement;
// by its title: while a prompt is up Radix aria-hides the dialog under it
const editDialog = () => (screen.queryByText("Edit Song")?.closest("[role=dialog]") as HTMLElement | null) ?? null;
const discardPrompt = () => screen.queryByText("ทิ้งที่แก้ไว้?");
const replacePrompt = () => screen.queryByText(/แทนที่ไฟล์เสียงของ “Akai Hana”/);
const settle = () => new Promise((r) => setTimeout(r, 50));

async function openEdit(song: Song) {
  render(
    <ConfirmProvider>
      <SongLibrary tenantId="t1" groups={groups} initialSongs={[song]} perms={makePerms("admin")} />
    </ConfirmProvider>
  );
  fireEvent.click(within(phoneList()).getByRole("button", { name: /^Akai Hana/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /แก้ไข/ }));
  return screen.findByRole("dialog", { name: "Edit Song" });
}
async function pickFile(dialog: HTMLElement) {
  fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [new File(["wav"], "take-2.wav", { type: "audio/wav" })] },
  });
  await waitFor(() => expect(within(dialog).getByText("take-2.wav")).toBeTruthy());
}

beforeEach(() => {
  document.body.innerHTML = "";
  h.writes.length = 0;
  h.uploads.length = 0;
  h.holds = {};
  h.uploadHold = undefined;
  vi.mocked(toast.error).mockClear();
});

describe("SongLibrary — closing the dialog while บันทึก still reads cancels that save", () => {
  it("during the band-move read: asks ทิ้งที่แก้ไว้?, แก้ต่อ leaves it idle with its form, and the save never writes", async () => {
    const read = gate();
    const dialog = await openEdit(base);
    fireEvent.change(within(dialog).getByDisplayValue("g1"), { target: { value: "g2" } });
    h.holds.setlist_items = read.promise; // songBandMoveBlocker's read waits
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "กำลังบันทึก…" })).toBeTruthy());

    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "แก้ต่อ" }));
    await settle();
    // open, idle, the move still on screen
    expect(editDialog()).toBeTruthy();
    expect(within(editDialog()!).getByRole("button", { name: "บันทึก" })).toBeEnabled();
    expect((within(editDialog()!).getByDisplayValue("g2") as HTMLSelectElement).value).toBe("g2");

    read.open(); // the read lands: the move is allowed - but that save was cancelled
    await settle();
    expect(h.writes).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("during the replace prompt's usage read: ทิ้ง closes, and no prompt and no upload come after", async () => {
    const read = gate();
    const dialog = await openEdit(withFile);
    await pickFile(dialog);
    h.holds.setlist_items = read.promise; // songUsage's count waits
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "กำลังบันทึก…" })).toBeTruthy());

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "ทิ้ง" }));
    await waitFor(() => expect(editDialog()).toBeNull());

    read.open();
    await settle();
    expect(replacePrompt()).toBeNull();
    expect(h.uploads).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("แก้ต่อ during the usage read: no prompt from the cancelled save, and บันทึก again asks as usual", async () => {
    const read = gate();
    const dialog = await openEdit(withFile);
    await pickFile(dialog);
    h.holds.setlist_items = read.promise;
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "กำลังบันทึก…" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(discardPrompt()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "แก้ต่อ" }));
    read.open();
    await settle();
    expect(replacePrompt()).toBeNull();
    expect(within(editDialog()!).getByText("take-2.wav")).toBeTruthy(); // the pick is kept

    h.holds = {};
    fireEvent.click(within(editDialog()!).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(replacePrompt()).toBeTruthy());
  });

  it("ยกเลิก once the upload has started: closes at once, and the upload goes on and lands", async () => {
    const upload = gate();
    h.uploadHold = upload.promise;
    const dialog = await openEdit(withFile);
    await pickFile(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    fireEvent.click(await screen.findByRole("button", { name: "แทนที่ไฟล์" }));
    await waitFor(() => expect(h.writes.some((w) => w.table === "songs")).toBe(true)); // the first write
    fireEvent.click(within(editDialog()!).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(editDialog()).toBeNull());
    expect(discardPrompt()).toBeNull();

    upload.open();
    await waitFor(() => expect(h.writes.some((w) => w.values.audio_name === "take-2.wav")).toBe(true));
    expect(h.uploads).toHaveLength(1);
  });
});
