// 2026-10-27 hunt (setlist): pre-existing (1264312), job 2.
// restoreSnapshot nulls every snapshot song_id that is not in the `songs` PROP:
//   song_id: song_id && libraryIds.has(song_id) ? song_id : null
// The prop is the library as it was when the event page loaded; nothing refreshes it.
// A song added to the library AFTER that (on another device - then linked in the set
// and saved as a version there) is not in it, so restoring that version on this page
// writes the row UNLINKED: Live Mode has no audio for it, and a song row with no link
// looks exactly like a linked one in the builder. The guard was meant only for songs
// DELETED since the save (the FK); it cannot tell "deleted" from "newer than my page".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem, Song } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";
const OLD_SONG = "50000000-0000-4000-8000-000000000001";
const NEW_SONG = "50000000-0000-4000-8000-000000000002"; // added after this page loaded

function item(id: string, sort_order: number, title: string, song_id: string | null): SetlistItem {
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
    song_id,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
  };
}

const ROW = item("aaaaaaaa-0000-4000-8000-000000000001", 1, "Old song", OLD_SONG);

let supa: SupabaseFake;
let realConfirm: typeof window.confirm | undefined;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setScript({
    setlist_versions: ok([
      {
        id: "v1",
        label: "ใส่เพลงใหม่แล้ว",
        created_at: "2026-10-26T10:00:00Z",
        snapshot: [
          { ...item("x", 1, "Old song", OLD_SONG) },
          { ...item("y", 2, "Brand-new single", NEW_SONG) },
        ].map((r) => {
          const s: Partial<SetlistItem> = { ...r };
          delete s.id;
          return s;
        }),
      },
    ]),
    // both songs exist on the server
    songs: ok([{ id: OLD_SONG }, { id: NEW_SONG }]),
    setlist_items: (call) =>
      call.verb === "delete"
        ? ok([{ id: ROW.id }])
        : call.verb === "insert"
          ? ok(
              (call.values as Partial<SetlistItem>[]).map((v, i) => ({
                ...item(`bbbbbbbb-0000-4000-8000-00000000000${i + 1}`, v.sort_order ?? i + 1, v.title ?? "", v.song_id ?? null),
              }))
            )
          : ok([]),
  });
  realConfirm = window.confirm;
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  window.confirm = realConfirm as typeof window.confirm;
  cleanup();
});

describe("SetlistBuilder — restoring a version keeps a song added to the library after the page loaded", () => {
  it("the restored row is still linked to its library song", async () => {
    const pageSongs = [{ id: OLD_SONG, title: "Old song", duration_seconds: 200 } as Song];
    render(
      <ConfirmProvider>
        <SetlistBuilder
          eventId={EVENT_ID}
          tenantId={TENANT_ID}
          editable
          initialItems={[ROW]}
          showStartTime="19:00"
          hardOutTime={null}
          members={[]}
          songs={pageSongs}
          eventName="Show"
        />
      </ConfirmProvider>
    );
    fireEvent.click(document.querySelector("svg.lucide-history")!.closest("button")!);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("svg.lucide-rotate-ccw")).toBeTruthy());
    await act(async () => {
      fireEvent.click(dialog.querySelector("svg.lucide-rotate-ccw")!.closest("button")!);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
    const sent = supa.callsTo("setlist_items", "insert")[0].values as Partial<SetlistItem>[];
    const single = sent.find((r) => r.title === "Brand-new single")!;
    expect(single.song_id).toBe(NEW_SONG);
  });
});
