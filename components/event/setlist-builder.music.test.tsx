// Music for a row that is not a song — an MC's bed, an SE, an interlude's track.
// พี่ 2026-10-17: "ช่อง mc ใด ๆ ก็สามารถกดใส่เพลงได้ … ตอนนี้ต้องมานั่งใส่เพลงแล้วเปลี่ยนเป็น MC".
// Live Mode already played any row linked to a library song; the editor only offered a song
// on SONG rows. Pinned here: "ใส่เพลง" on every other kind, one write carrying the link and
// nothing that would bend the slot - the row keeps its title and its OWN length (an empty
// 0:00 slot starts at the file's), and an MC's music loops - plus the music line under the
// row (what is linked, Loop, เอาออก).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem, Song } from "@/lib/types";

const EVENT_ID = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-4444-4444-8444-tttttttttttt";

const row = (
  id: string,
  sort: number,
  title: string,
  kind: SetlistItem["kind"],
  dur: number,
  extra: Partial<SetlistItem> = {}
): SetlistItem => ({
  id,
  event_id: EVENT_ID,
  tenant_id: TENANT_ID,
  kind,
  title,
  sort_order: sort,
  duration_seconds: dur,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
  song_id: null,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
  ...extra,
});

const song = (id: string, title: string, dur: number): Song => ({
  id,
  tenant_id: TENANT_ID,
  group_id: "g1",
  title,
  file_name: null,
  duration_seconds: dur,
  language: null,
  category: null,
  copyright_status: "cleared",
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const SONGS = [
  song("lib-bgm", "MC BGM (piano)", 100),
  song("lib-boot", "[SYSTEM_BOOT] SE", 96),
  song("lib-iam", "I Am Who I Am", 235),
];

const SET = [
  row("s1", 1, "I Am Who I Am", "song", 235, { song_id: "lib-iam" }),
  row("mc", 2, "MC", "mc", 180, { notes: "แนะนำตัว", mic_slots: [{ mic: "1", member: "Yuki" }] }),
  row("se", 3, "SE", "se", 20),
  row("mc0", 4, "MC ปิดท้าย", "mc", 0),
  row("mcm", 5, "MC 2", "mc", 150, { song_id: "lib-bgm", loop_audio: true }),
];

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setScript({
    setlist_items: (call) =>
      call.verb === "update"
        ? ok([{ id: "x" }])
        : call.verb === "insert"
          ? ok({ ...(call.values as object), id: "new-row" })
          : ok([]),
  });
});

const mount = (opts: { editable?: boolean; songs?: Song[]; items?: SetlistItem[] } = {}) =>
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable={opts.editable ?? true}
        initialItems={opts.items ?? SET}
        showStartTime="13:00:00"
        hardOutTime="13:30:00"
        members={[]}
        songs={opts.songs ?? SONGS}
        eventName="Test show"
      />
    </ConfirmProvider>
  );

const attachButton = (rowId: string) => document.querySelector<HTMLElement>(`[data-attach-row="${rowId}"]`);
const updates = () => supa.callsTo("setlist_items", "update");

async function pick(rowId: string, title: RegExp) {
  fireEvent.click(attachButton(rowId)!);
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: title }));
  });
  await waitFor(() => expect(updates().length).toBeGreaterThan(0));
  return dialog;
}

describe("SetlistBuilder — music for a row that is not a song", () => {
  it("is offered on every kind but SONG, to an editor with a library", () => {
    const { unmount } = mount();
    expect(attachButton("mc")).not.toBeNull();
    expect(attachButton("se")).not.toBeNull();
    expect(attachButton("mc0")).not.toBeNull();
    expect(attachButton("s1")).toBeNull(); // a song row swaps its song (เปลี่ยน) instead
    expect(attachButton("mcm")).toBeNull(); // has music already: its music line offers the swap
    unmount();
    const r2 = mount({ songs: [] });
    expect(attachButton("mc")).toBeNull(); // nothing to pick
    r2.unmount();
    mount({ editable: false });
    expect(attachButton("mc")).toBeNull();
  });

  it("an MC keeps its title, its length, its mics and notes - and its music loops", async () => {
    mount();
    const dialog = await pick("mc", /MC BGM/);
    expect(dialog).toHaveTextContent("ใส่เพลงแถวที่ 2");
    expect(updates()).toHaveLength(1);
    const call = updates()[0];
    expect(call.values).toEqual({ song_id: "lib-bgm", loop_audio: true });
    expect(call.filters).toContainEqual(expect.objectContaining({ column: "id", value: "mc" }));
    expect(screen.getByDisplayValue("MC")).toBeInTheDocument();
    expect(screen.getByDisplayValue("แนะนำตัว")).toBeInTheDocument();
    expect(supa.callsTo("setlist_items", "insert")).toHaveLength(0);
  });

  it("an empty 0:00 slot starts at the file's length (then it is the row's to change)", async () => {
    mount();
    await pick("mc0", /MC BGM/);
    expect(updates()[0].values).toEqual({ song_id: "lib-bgm", duration_seconds: 100, loop_audio: true });
  });

  it("an SE gets its file without a loop", async () => {
    mount();
    await pick("se", /SYSTEM_BOOT/);
    expect(updates()[0].values).toEqual({ song_id: "lib-boot" });
  });

  it("the music line: what is linked, Loop on / off, เอาออก - the row's own title and length stay", async () => {
    mount();
    const line = screen.getByTestId("row-music-mcm");
    expect(line).toHaveTextContent("MC BGM (piano)");
    const loop = within(line).getByRole("switch", { name: /Loop/ });
    expect(loop).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      fireEvent.click(loop);
    });
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0].values).toEqual({ loop_audio: false });
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("row-music-mcm")).getByRole("button", { name: "เอาเพลงออก" }));
    });
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1].values).toEqual({ song_id: null });
    expect(screen.queryByTestId("row-music-mcm")).toBeNull();
    expect(screen.getByDisplayValue("MC 2")).toBeInTheDocument();
    expect(attachButton("mcm")).not.toBeNull(); // and it can take music again
  });

  it("swapping an MC's music keeps the Loop its operator chose", async () => {
    mount({ items: [row("mcm", 1, "MC 2", "mc", 150, { song_id: "lib-bgm", loop_audio: false })] });
    fireEvent.click(within(screen.getByTestId("row-music-mcm")).getByRole("button", { name: /เปลี่ยนเพลง/ }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /SYSTEM_BOOT/ }));
    });
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0].values).toEqual({ song_id: "lib-boot" });
  });

  it("a copied row brings its music link and its Loop (a pointer to the library, not a file)", async () => {
    mount();
    const copy = within(screen.getByTestId("row-music-mcm").closest("[data-setlist-row]") as HTMLElement).getByRole(
      "button",
      { name: "ก๊อปรายการนี้" }
    );
    await act(async () => {
      fireEvent.click(copy);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
    expect(supa.callsTo("setlist_items", "insert")[0].values).toMatchObject({
      kind: "mc",
      title: "MC 2",
      song_id: "lib-bgm",
      loop_audio: true,
    });
  });
});
