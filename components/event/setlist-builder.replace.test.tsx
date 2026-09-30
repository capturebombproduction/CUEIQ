// "เปลี่ยน" — swap a row's song for another from the library, IN PLACE.
// Measured 2026-09-28: of 60 songs that came into Seishin Kakumei's last 18 shows,
// 52 landed mid-set, and the only way there was delete → "จากคลัง" (appended last)
// → ▲ once per row. Pinned here: one write, carrying exactly the new song's title,
// length and link — the row's place, mics and notes (the band's standing mics and
// cues for the SLOT) are left alone — and the button only where it means something.
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

const EVENT_ID = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-3333-4333-8333-tttttttttttt";

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
  song("lib-boot", "[SYSTEM_BOOT] SE", 96),
  song("lib-iam", "I Am Who I Am", 235),
  song("lib-eve", "Eve of the Revolution", 244),
  song("lib-new", "Brand New Song", 0), // added to the library, length not set yet
];

const SET = [
  row("s1", 1, "[SYSTEM_BOOT] SE", "song", 96, { song_id: "lib-boot" }),
  row("s2", 2, "I Am Who I Am", "song", 235, {
    song_id: "lib-iam",
    notes: "เล่นต่อเนื่อง",
    mic_slots: [{ mic: "1", member: "Yuki" }],
  }),
  row("mc", 3, "MC", "mc", 255),
];

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setScript({
    setlist_items: (call) => (call.verb === "update" ? ok([{ id: "s2" }]) : ok([])),
  });
});

const mount = (opts: { editable?: boolean; songs?: Song[] } = {}) =>
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable={opts.editable ?? true}
        initialItems={SET}
        showStartTime="13:00:00"
        hardOutTime="13:20:00"
        members={[]}
        songs={opts.songs ?? SONGS}
        eventName="Test show"
      />
    </ConfirmProvider>
  );

const replaceButtons = () => screen.queryAllByRole("button", { name: /เปลี่ยน$/ });
const titles = () =>
  (screen.getAllByPlaceholderText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[]).map((i) => i.value);

describe("SetlistBuilder — swap a song in place", () => {
  it("writes the new song's title, length and link to THAT row, and nothing else", async () => {
    mount();
    fireEvent.click(replaceButtons()[1]); // row 2, "I Am Who I Am"
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("เปลี่ยนเพลงแถวที่ 2");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Eve of the Revolution/ }));
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(1));
    const call = supa.callsTo("setlist_items", "update")[0];
    // Exactly these three — mic_slots, notes, sort_order are not in the write.
    expect(call.values).toEqual({ title: "Eve of the Revolution", duration_seconds: 244, song_id: "lib-eve" });
    expect(call.filters).toContainEqual(expect.objectContaining({ column: "id", value: "s2" }));
    // Same place; nothing was inserted or deleted to get there.
    expect(titles()).toEqual(["[SYSTEM_BOOT] SE", "Eve of the Revolution", "MC"]);
    expect(supa.callsTo("setlist_items", "insert")).toHaveLength(0);
    expect(supa.callsTo("setlist_items", "delete")).toHaveLength(0);
    expect(screen.getByDisplayValue("เล่นต่อเนื่อง")).toBeInTheDocument(); // the slot's cue stays
  });

  it("a song with no length yet keeps the row's — 0:00 would pull every later start forward", async () => {
    mount();
    fireEvent.click(replaceButtons()[1]); // row 2, 235 s
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Brand New Song/ }));
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(1));
    expect(supa.callsTo("setlist_items", "update")[0].values).toEqual({
      title: "Brand New Song",
      duration_seconds: 235,
      song_id: "lib-new",
    });
  });

  it("marks the songs already in the set, without blocking them (a set can repeat one)", async () => {
    mount();
    fireEvent.click(replaceButtons()[0]);
    const dialog = await screen.findByRole("dialog");
    const pick = (name: RegExp) => within(dialog).getByRole("button", { name });
    expect(pick(/I Am Who I Am/)).toHaveTextContent("อยู่ในเซ็ตแล้ว");
    expect(pick(/I Am Who I Am/)).not.toBeDisabled();
    expect(pick(/Eve of the Revolution/)).not.toHaveTextContent("อยู่ในเซ็ตแล้ว");
  });

  it("is offered on song rows only — not MC — and only to an editor with a library", () => {
    const { unmount } = mount();
    expect(replaceButtons()).toHaveLength(2); // two songs, one MC
    unmount();
    const r2 = mount({ songs: [] });
    expect(replaceButtons()).toHaveLength(0); // nothing to swap to
    r2.unmount();
    mount({ editable: false });
    expect(replaceButtons()).toHaveLength(0);
  });
});
