// 2026-10-27 hunt (livecore). Harness copied from components/event/live-mode.hunt-1026.test.tsx.
// c4388cf: the Loop end-fade's restore now also fires on `state.mode !== "auto"` (live-mode.tsx ~4438-4451).
// Auto Mute pressed in a Loop bed's last 3 s (Auto), then MANUAL to hold: the restore cancels Auto Mute's
// fade and puts the bed back at its level - the bed the operator just muted comes back, audible.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "@/components/event/live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const TOPIC = liveTopic(EVENT_ID);

function makeItem(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `Track ${n}`,
    duration_seconds: 240,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    sort_order: n,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
    ...over,
  };
}

let supa: SupabaseFake;
function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
const stateSends = () => live().sent.filter((s) => s.event === "state");

async function mountLive(items: SetlistItem[]) {
  supa.setScript({ setlist_items: ok(items), songs: ok([]), show_authority: ok([]) });
  const view = render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Probe"
      items={items}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  return view;
}
async function startShowFromUi() {
  await act(async () => {
    live().setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  expect(stateSends()[0]).toBeTruthy();
}
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok([]), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now() + 60_000), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const autoMuteKey = () => screen.getAllByTitle("ค่อย ๆ ปิดเสียงเป็น 0% ใน 3 วินาที")[0];

describe("LiveMode — Auto Mute in a Loop bed's end-fade, then MANUAL", () => {
  it("the bed the operator muted stays muted", async () => {
    const set = [
      makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 240 }),
    ];
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(set);
    await startShowFromUi();
    const primary = media.first()!;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(7_750); // inside the bed's last 3 s: Auto's end-fade is on
    // the MC wraps up early: kill the bed...
    await act(async () => {
      fireEvent.click(autoMuteKey());
    });
    await tick(250);
    expect(media.state(primary).volume).toBeCloseTo(0); // muted, as pressed
    // ...and hold the show so Auto does not start the next song
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Manual$/ }));
    });
    await tick(3_000);
    expect(media.state(primary).paused).toBe(false); // the bed loops on (Manual's promise)
    // BUG: MANUAL gave the bed its level back - the muted bed is audible again
    expect(media.state(primary).volume).toBeCloseTo(0);
  });

  it("control: MANUAL in the end-fade without Auto Mute keeps the bed's level (P1)", async () => {
    const set = [
      makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 240 }),
    ];
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(set);
    await startShowFromUi();
    const primary = media.first()!;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(7_750);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Manual$/ }));
    });
    await tick(3_000);
    expect(media.state(primary).volume).toBeCloseTo(0.3);
  });
});
