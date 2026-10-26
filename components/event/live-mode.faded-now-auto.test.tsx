// Hunt 6 (2026-10-27, live). Manual → AUTO anchors to the track that is SOUNDING (memory
// cueiq-manual-auto-anchor; setMode("auto")). NOW's own green pad fades it (stopNowPad: its sound
// is over, the row stays on). The 2026-10-25 hunt made a cue placed BEFORE that fade un-commit
// the faded row, so AUTO goes on from the cue. In the other order - fade first, THEN cue the next
// row - committedRef still named the faded row, and AUTO read it as the sounding track: it played
// again at full level, a row behind the cue. Same for a file that played out inside its slot: AUTO
// took the show back to its silent leftover slot. Nothing sounding, AUTO now goes on from the row
// the show stands on (the cue) in both orders; a sounding track, and a committed row this device
// holds no file for (an MC talk), still anchor AUTO as before.
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

async function startPads(set = SET, noFile: string[] = []) {
  const media = instrumentMediaElements();
  supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
  h.saved = set.filter((it) => !noFile.includes(it.id)).map((it) => ({
    itemId: it.id,
    blob: Object.assign(new Blob([it.id]), { row: it.id }),
    name: `${it.id}.wav`,
    path: null,
  }));
  await mountLive(set);
  await startShowFromUi();
  return media;
}
const pads = () => screen.getAllByTestId("console-pad");
const pad = (n: number) => pads()[n - 1];
const press = async (n: number) => {
  await act(async () => {
    fireEvent.click(pad(n));
  });
};
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


const autoKey = () => screen.getAllByRole("button", { name: "Auto" })[0];
const cueNext = async () => {
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {});
};

describe("LiveMode · Manual → AUTO when NOW's sound is over (hunt 6)", () => {
  it("cue first, then NOW's pad fades it, then AUTO: Auto goes on from the cue (2026-10-25)", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3); // NOW = row 3, row 1 under it
    await tick(1_000);
    await cueNext(); // row 4 cued
    await press(3); // row 3's sound fades out
    await tick(3_250);
    expect(playing(media, "item-3")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(playing(media, "item-3")).toHaveLength(0);
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 3, running: true });
    expect(playing(media, "item-4")).toHaveLength(1);
  });

  it("NOW's pad fades it first, then a row is cued, then AUTO: the faded song does not come back", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    await tick(1_000);
    await press(3); // row 3's sound fades out - the row stays on, its clock runs
    await tick(3_250);
    expect(playing(media, "item-3")).toHaveLength(0);
    await cueNext(); // row 4 cued: what the show stands on now
    expect(last()).toMatchObject({ currentIndex: 3, running: false });
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(playing(media, "item-3")).toHaveLength(0);
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 3, running: true });
    expect(playing(media, "item-4")).toHaveLength(1);
  });

  it("a file that played out inside its slot, then a row cued, then AUTO: Auto goes on from the cue", async () => {
    const media = await startPads();
    await tick(10_000);
    await act(async () => {
      media.emit(media.first()!, "ended"); // a short file in a longer slot
    });
    await tick(500);
    await cueNext(); // row 2 cued
    expect(last()).toMatchObject({ currentIndex: 1, running: false });
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 1, running: true });
    expect(playing(media, "item-2")).toHaveLength(1);
    expect(playing(media, "item-1")).toHaveLength(0);
  });

  it("no cue: AUTO after NOW's pad faded it stays on that row and its clock, as before", async () => {
    await startPads();
    await tick(2_000);
    await press(3);
    await tick(1_000);
    await press(3);
    await tick(3_250);
    const before = last().itemStartedAt;
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 2, running: true });
    expect(Math.abs(last().itemStartedAt - before)).toBeLessThan(5);
  });

  it("a row this device holds no file for (an MC talk) cued past, then AUTO: it is still the anchor", async () => {
    await startPads(SET, ["item-3"]);
    await tick(2_000);
    await press(3); // the MC talk row, no file here: NOW, nothing new sounds
    await tick(1_000);
    await cueNext(); // the next row merely cued
    expect(last()).toMatchObject({ currentIndex: 3, running: false });
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 2, running: true });
  });

  it("a song still sounding, a row cued, then AUTO: AUTO resumes the sounding song (the anchor rule)", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    await tick(1_000);
    await cueNext(); // row 4 cued, row 3 sounds on
    await act(async () => {
      fireEvent.click(autoKey());
    });
    expect(last()).toMatchObject({ mode: "auto", currentIndex: 2, running: true });
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(playing(media, "item-4")).toHaveLength(0);
  });
});
