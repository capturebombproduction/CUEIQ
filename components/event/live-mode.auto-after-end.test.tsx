// Hunt 6 (2026-10-27, live). จบโชว์ pauses the PA and clears committedRef, but the paused element
// still holds the last song (playingId). The mode key stays live after the show ended, and AUTO
// tapped there ran setMode("auto") as a resume: offset 0 (no committed anchor any more), the last
// song back on from 0:00, and apply(running) told every device the show was on again. After
// จบโชว์ AUTO only sets the mode; RUN is still the encore.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
  type MediaInstrumentation,
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
const stateSends = (ch = live()) => ch.sent.filter((s) => s.event === "state");

async function mountLive(items: SetlistItem[]) {
  const view = render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Pads"
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

const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
const SET = [
  makeItem(1, { duration_seconds: 200 }),
  makeItem(2, { duration_seconds: 200 }),
  makeItem(3, { duration_seconds: 200 }),
  makeItem(4, { kind: "mc", title: "MC BGM", loop_audio: true, duration_seconds: 120 }),
  makeItem(5, { duration_seconds: 200 }),
  makeItem(6, { duration_seconds: 200 }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok(SET), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
  localStorage.setItem("cueiq:liveView", "console");
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === STAGE_QUERY,
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.removeItem("cueiq:liveView");
  vi.useRealTimers();
});

async function startPads(set = SET) {
  const media = instrumentMediaElements();
  supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
  h.saved = set.map((it) => ({
    itemId: it.id,
    blob: Object.assign(new Blob([it.id]), { row: it.id }),
    name: `${it.id}.wav`,
    path: null,
  }));
  await mountLive(set);
  await startShowFromUi();
  return media;
}
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};
const playing = (media: MediaInstrumentation, id: string) =>
  media.elements.filter((el) => media.state(el).src === `blob:${id}` && !media.state(el).paused);
const last = () => stateSends().at(-1)!.payload;


describe("LiveMode · AUTO tapped after จบโชว์ (hunt 6)", () => {
  it("the ended show stays silent and ended; the mode is AUTO; RUN is still the encore", async () => {
    const media = await startPads();
    await tick(30_000);
    expect(playing(media, "item-1")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    expect(playing(media, "item-1")).toHaveLength(0);
    expect(last().ended).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Auto" })[0]);
    });
    expect(playing(media, "item-1")).toHaveLength(0);
    expect(last()).toMatchObject({ ended: true, running: false, mode: "auto" });
    // the encore, by RUN: the last song carries on from where จบโชว์ stopped it
    const at = media.state(media.first()!).currentTime;
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    expect(playing(media, "item-1")).toHaveLength(1);
    expect(media.state(media.first()!).currentTime).toBe(at);
    expect(last()).toMatchObject({ ended: false, running: true });
  });
});
