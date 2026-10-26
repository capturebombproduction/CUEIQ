// The row a running Live Mode has on air is locked in the builder (no trash key, no
// edits). Two paths could still take it away from under Live Mode, because each waits
// on a dialog while the show moves on:
//  • ลบรายการ: removeItem read `items`, awaited the confirm sheet and then deleted -
//    never asking again whether the row went on air meanwhile. Show-day shape: running
//    late, the Ar taps 🗑 on the NEXT song to cut it; Auto (or the operator's NEXT) takes
//    that song on air while the sheet is up; ลบ → the playing row is deleted, and Live
//    Mode's refetch clamps its index onto the following row. "เปลี่ยน" and "ใส่เพลง"
//    already re-checked after their dialog; delete, the irreversible one, did not.
//  • กู้คืน (version history): a restore replaces EVERY row with fresh ids, the one on
//    air included.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toastSpy = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

function item(id: string, sort_order: number, title: string): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: 200,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
  };
}

const NOW = item("aaaaaaaa-0000-4000-8000-000000000001", 1, "Playing now");
const NEXT = item("aaaaaaaa-0000-4000-8000-000000000002", 2, "Next song");
const LAST = item("aaaaaaaa-0000-4000-8000-000000000003", 3, "Closer");

let supa: SupabaseFake;
let realConfirm: typeof window.confirm | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setScript({
    setlist_versions: ok([
      {
        id: "v1",
        label: "ก่อนซ้อม",
        created_at: "2026-10-20T10:00:00Z",
        snapshot: [NOW, NEXT].map((r) => {
          const s: Partial<SetlistItem> = { ...r };
          delete s.id; // a saved version carries no row ids
          return s;
        }),
      },
    ]),
    setlist_items: (call) =>
      call.verb === "delete"
        ? ok([{ id: call.eq.id }])
        : call.verb === "insert"
          ? ok([item("bbbbbbbb-0000-4000-8000-000000000001", 1, "Restored")])
          : ok([]),
  });
  // The setup file leaves window.confirm undefined; SetlistVersions gates on it.
  realConfirm = window.confirm;
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  window.confirm = realConfirm as typeof window.confirm;
  cleanup();
});

function mount() {
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={[NOW, NEXT, LAST]}
        showStartTime="19:00"
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Show"
      />
    </ConfirmProvider>
  );
  const ch = supa.channelFor(liveTopic(EVENT_ID))!;
  expect(ch, "the builder joined the show channel").toBeTruthy();
  return ch;
}

describe("setlist builder vs the show moving on while a dialog is open", () => {
  it("does not delete a row that went on air while the confirm sheet was open", async () => {
    const ch = mount();
    // the show is running, NOW on air - its row is locked (no trash key on it)
    act(() => {
      ch.emit("state", { begun: true, currentItemId: NOW.id });
    });
    const trash = screen.getAllByRole("button", { name: "ลบรายการนี้" });
    expect(trash).toHaveLength(2); // NEXT and LAST only

    // the Ar taps 🗑 on NEXT…
    await act(async () => {
      fireEvent.click(trash[0]);
    });
    await screen.findByRole("dialog");
    // …and while the sheet is up the show moves on: NEXT is on air now
    act(() => {
      ch.emit("state", { begun: true, currentItemId: NEXT.id });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ลบ" }));
    });
    await act(async () => {});

    expect(supa.callsTo("setlist_items", "delete")).toEqual([]);
    expect(toastSpy.error).toHaveBeenCalledWith("แถวนี้กำลังเล่นอยู่บนเวที — ยังลบไม่ได้");
    // and the row is still on screen
    expect(screen.getByDisplayValue("Next song")).toBeTruthy();
  });

  it("still deletes a row that stayed off air", async () => {
    const ch = mount();
    act(() => {
      ch.emit("state", { begun: true, currentItemId: NOW.id });
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "ลบรายการนี้" })[1]); // LAST
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ลบ" }));
    });
    await waitFor(() =>
      expect(supa.callsTo("setlist_items", "delete").map((c) => c.eq.id)).toEqual([LAST.id])
    );
  });

  it("refuses to restore a saved version while a row is on air", async () => {
    const ch = mount();
    fireEvent.click(document.querySelector("svg.lucide-history")!.closest("button")!);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("svg.lucide-rotate-ccw")).toBeTruthy());
    // the version list sits open; the show starts and NOW goes on air
    act(() => {
      ch.emit("state", { begun: true, currentItemId: NOW.id });
    });
    await act(async () => {
      fireEvent.click(dialog.querySelector("svg.lucide-rotate-ccw")!.closest("button")!);
    });

    expect(supa.callsTo("setlist_items", "insert")).toEqual([]);
    expect(supa.callsTo("setlist_items", "delete")).toEqual([]);
    expect(toastSpy.error).toHaveBeenCalledWith(
      "กู้คืนไม่สำเร็จ",
      expect.objectContaining({ description: expect.stringMatching(/กำลังเล่นอยู่บนเวที/) })
    );
    expect(screen.getByDisplayValue("Playing now")).toBeTruthy();
  });

  it("restores once the show has ended", async () => {
    const ch = mount();
    act(() => {
      ch.emit("state", { begun: true, currentItemId: NOW.id });
    });
    act(() => {
      ch.emit("state", { begun: false, currentItemId: NOW.id });
    });
    fireEvent.click(document.querySelector("svg.lucide-history")!.closest("button")!);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("svg.lucide-rotate-ccw")).toBeTruthy());
    await act(async () => {
      fireEvent.click(dialog.querySelector("svg.lucide-rotate-ccw")!.closest("button")!);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
  });
});
