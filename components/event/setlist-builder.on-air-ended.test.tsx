// 2026-10-27 hunt (setlist): c4388cf made restoreSnapshot refuse
// whenever liveItemIdRef is set. That ref follows `payload.begun ? currentItemId : null`
// and ignores `payload.ended`. จบโชว์ in live-mode.tsx leaves begun:true on purpose and
// broadcasts ended:true (statePayload) - so after the show has ENDED (the controller is
// still open and still answers every sync-request with begun:true) the builder refuses
// every restore with "โชว์กำลังเล่นอยู่ ... รอให้จบโชว์ก่อนค่อยกู้คืน".
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

const NOW = item("aaaaaaaa-0000-4000-8000-000000000001", 1, "Opener");
const LAST = item("aaaaaaaa-0000-4000-8000-000000000003", 2, "Closer");

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
        snapshot: [NOW, LAST].map((r) => {
          const s: Partial<SetlistItem> = { ...r };
          delete s.id;
          return s;
        }),
      },
    ]),
    setlist_items: (call) =>
      call.verb === "delete"
        ? ok([{ id: NOW.id }, { id: LAST.id }])
        : call.verb === "insert"
          ? ok([item("bbbbbbbb-0000-4000-8000-000000000001", 1, "Restored")])
          : ok([]),
  });
  realConfirm = window.confirm;
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  window.confirm = realConfirm as typeof window.confirm;
  cleanup();
});

describe("SetlistBuilder — a show that has ENDED (จบโชว์) holds no row on air", () => {
  it("restores after จบโชว์ (begun stays true, ended:true rides the broadcast)", async () => {
    render(
      <ConfirmProvider>
        <SetlistBuilder
          eventId={EVENT_ID}
          tenantId={TENANT_ID}
          editable
          initialItems={[NOW, LAST]}
          showStartTime="19:00"
          hardOutTime={null}
          members={[]}
          songs={[]}
          eventName="Show"
        />
      </ConfirmProvider>
    );
    const ch = supa.channelFor(liveTopic(EVENT_ID))!;
    // exactly what live-mode.tsx statePayload sends after จบโชว์ (markShowEnded(true)
    // keeps begun:true; currentItemId is the row the show stopped on)
    act(() => {
      ch.emit("state", { begun: true, ended: true, running: false, currentItemId: LAST.id });
    });
    fireEvent.click(document.querySelector("svg.lucide-history")!.closest("button")!);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("svg.lucide-rotate-ccw")).toBeTruthy());
    await act(async () => {
      fireEvent.click(dialog.querySelector("svg.lucide-rotate-ccw")!.closest("button")!);
    });
    // the show is over - the restore must go through
    await waitFor(() => expect(supa.callsTo("setlist_items", "insert")).toHaveLength(1));
  });

  it("does not keep the closing row locked after จบโชว์", async () => {
    render(
      <ConfirmProvider>
        <SetlistBuilder
          eventId={EVENT_ID}
          tenantId={TENANT_ID}
          editable
          initialItems={[NOW, LAST]}
          showStartTime="19:00"
          hardOutTime={null}
          members={[]}
          songs={[]}
          eventName="Show"
        />
      </ConfirmProvider>
    );
    const ch = supa.channelFor(liveTopic(EVENT_ID))!;
    act(() => {
      ch.emit("state", { begun: true, ended: true, running: false, currentItemId: LAST.id });
    });
    // both rows keep their trash key once the show is over
    expect(screen.getAllByRole("button", { name: "ลบรายการนี้" })).toHaveLength(2);
  });
});
