// 2026-10-30, hunt 10 (mistakes-4): "ล้าง" beside เวลาโชว์ล่าสุด - in Live tools right under จบโชว์ /
// รีเซ็ต - wiped the show's one record of its run time, on every device (persistLastRun + the
// "lastrun" broadcast), on a single tap. The label's rule is a confirm before every delete; it now
// asks first, in Reset's own window.confirm style.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown, persist: vi.fn(async () => "saved") }));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/show-run-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/show-run-outbox")>()),
  persistLastRun: h.persist,
}));

import { LiveMode } from "@/components/event/live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";

const item: SetlistItem = {
  id: "item-1",
  tenant_id: "tenant-1",
  event_id: EVENT_ID,
  kind: "song",
  title: "Track 1",
  duration_seconds: 240,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
  sort_order: 1,
  song_id: null,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
};

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok([item]), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
  h.persist.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountWithRecord() {
  render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Ichiban"
      items={[item]}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={754}
      lastRunAt="2026-10-29T11:00:00Z"
    />
  );
  await act(async () => {});
}
const clearKey = () => screen.getAllByTitle("ล้างเวลาโชว์ล่าสุดที่บันทึกไว้")[0];
const lastrunSends = () => (supa.channelFor(liveTopic(EVENT_ID))?.sent ?? []).filter((s) => s.event === "lastrun");

describe("LiveMode · ล้าง เวลาโชว์ล่าสุด asks first", () => {
  it("answered no: the record stays here and on the server, and no device is told", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    await mountWithRecord();
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(clearKey());
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
    expect(h.persist).not.toHaveBeenCalled();
    expect(lastrunSends()).toHaveLength(0);
  });

  it("answered yes: cleared as before - here, on the server and on every device", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mountWithRecord();
    await act(async () => {
      fireEvent.click(clearKey());
    });
    expect(screen.queryAllByText("12:34")).toHaveLength(0);
    expect(h.persist).toHaveBeenCalledWith(EVENT_ID, null, null);
    expect(lastrunSends().at(-1)?.payload).toEqual({ record: null });
  });
});
