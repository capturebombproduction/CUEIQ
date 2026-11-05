// The PA's clock against its files, two more ways (2026-11-05, hunt 13; the rule they extend is
// hunt 12's - see live-mode.machine-world.test.tsx). What used to go wrong:
// · A song that ENDED inside a JS freeze - the leave-Live window.confirm read and answered
//   "Cancel", any stall over 3 s; the audio thread plays on through one - was taken for a silent
//   row: its clock was pushed back by the whole freeze, AUTO sat silent for as long again as the
//   song had had left, and the toast said the machine had stopped.
// · The wall clock set BACK under a running show (Windows' time sync steps it) was never seen:
//   every row ran long by the step - dead air at the end of a song in AUTO - and the show's total
//   lost it.
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
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: h.toast, Toaster: () => null }));
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
const live = (): ChannelFake => supa.channelFor(TOPIC)!;
const stateSends = () => live().sent.filter((s) => s.event === "state");
const lastState = () =>
  stateSends().at(-1)!.payload as { currentIndex: number; itemStartedAt: number; startedAt: number; running: boolean };
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) await act(async () => void vi.advanceTimersByTime(250));
};
const gapToasts = () => h.toast.warning.mock.calls.filter((c) => String(c[0]).includes("เครื่องหยุดไป"));
const setVisibility = (v: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });

async function startAuto(set: SetlistItem[], withFiles = true): Promise<MediaInstrumentation> {
  const media = instrumentMediaElements();
  h.saved = withFiles
    ? set.filter((it) => it.kind === "song").map((it) => ({ itemId: it.id, blob: new Blob([it.id]), name: `${it.id}.wav`, path: null }))
    : [];
  supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
  render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Clock"
      items={set}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  await act(async () => live().setStatus("SUBSCRIBED"));
  await act(async () => void vi.advanceTimersByTime(2_000));
  await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/ })));
  return media;
}
/** The song plays on its own (sound card) clock: one second of file per second of real time. */
function player(media: MediaInstrumentation, el: HTMLMediaElement, duration: number) {
  let at = 0;
  media.set(el, { duration });
  return async (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      at = Math.min(duration, at + 0.25);
      media.set(el, { currentTime: at });
      await act(async () => void vi.advanceTimersByTime(250));
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-08T17:30:00+07:00"));
  h.saved = [];
  for (const f of Object.values(h.toast)) f.mockClear();
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
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe("LiveMode · a normal tick", () => {
  it("moves nothing and says nothing while a song plays", async () => {
    const media = await startAuto([makeItem(1), makeItem(2)]);
    const play = player(media, media.first()!, 240);
    await play(10_000);
    const sends = stateSends().length;
    const at = lastState().itemStartedAt;
    await play(60_000);
    expect(stateSends().length).toBe(sends);
    expect(lastState().itemStartedAt).toBe(at);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);
});

describe("LiveMode · a song that ends inside a JS freeze", () => {
  /** No JS for `ms` (a window.confirm read, then Cancel) from 3:50 of a 4:00 row: the audio thread
   *  played the song out to its end (4:00.4) inside it. */
  async function freezeOverTheEnd(ms: number) {
    const media = await startAuto([makeItem(1), makeItem(2)]);
    const song = media.first()!;
    await tick(230_000);
    media.set(song, { duration: 240.4, currentTime: 230 });
    await tick(500); // a tick has seen the file at 3:50
    vi.setSystemTime(Date.now() + ms);
    media.set(song, { currentTime: 240.4, ended: true });
    await tick(1_000);
  }

  it("counts as played: a freeze that ends with the song moves nothing, says nothing, and AUTO moves on at once", async () => {
    vi.stubGlobal("cueiqNative", new Proxy({}, { get: () => async () => undefined })); // the PA laptop
    await freezeOverTheEnd(10_500);
    expect(lastState().currentIndex).toBe(1); // used to: 10 s more of silence on row 1
    expect(gapToasts()).toHaveLength(0); // used to: "เครื่องหยุดไป 11 วินาที"
  }, 30_000);

  it("a freeze that outlasts the song: nothing was lost, AUTO still moves on at once, and nothing says the machine stopped", async () => {
    await freezeOverTheEnd(13_000);
    expect(lastState().currentIndex).toBe(1); // used to: 9 s more of silence on row 1
    // the file ran to its end inside the freeze: no "เครื่องหยุดไป", and no row moved to hide the time since
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a hidden web tab whose song ended between throttled ticks is left on wall time, as before", async () => {
    const media = await startAuto([makeItem(1), makeItem(2)]);
    const song = media.first()!;
    await tick(230_000);
    media.set(song, { duration: 240.4, currentTime: 230 });
    await tick(500);
    setVisibility("hidden");
    const sends = stateSends().length;
    vi.setSystemTime(Date.now() + 8_000); // still inside the row: nothing to advance to yet
    media.set(song, { currentTime: 240.4, ended: true });
    await act(async () => void vi.advanceTimersByTime(250));
    await act(async () => void vi.advanceTimersByTime(250));
    expect(stateSends().length).toBe(sends); // its row clock untouched
  }, 30_000);
});

describe("LiveMode · the wall clock set BACK under a running show (a time sync)", () => {
  it("a song: AUTO takes the next row when the song ends, not the step later, and says nothing", async () => {
    const media = await startAuto([makeItem(1), makeItem(2)]);
    const play = player(media, media.first()!, 240);
    await play(100_000);
    vi.setSystemTime(Date.now() - 5_000);
    await play(140_500); // real time 4:00.5: the file is at its end
    expect(lastState().currentIndex).toBe(1); // used to: 5 s of dead air first
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a row with no file keeps its time", async () => {
    vi.stubGlobal("cueiqNative", new Proxy({}, { get: () => async () => undefined }));
    await startAuto([makeItem(1, { kind: "mc", duration_seconds: 120 }), makeItem(2)], false);
    await tick(60_000);
    vi.setSystemTime(Date.now() - 5_000);
    await tick(60_500); // real time 2:00.5
    expect(lastState().currentIndex).toBe(1); // used to: 5 s more of the MC row
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("on a hidden web tab too: a step back is no throttled tick", async () => {
    await startAuto([makeItem(1, { kind: "mc", duration_seconds: 120 }), makeItem(2)], false);
    await tick(60_000);
    setVisibility("hidden");
    vi.setSystemTime(Date.now() - 5_000);
    await tick(60_500);
    expect(lastState().currentIndex).toBe(1);
  }, 30_000);

  it("the show's total does not lose the step", async () => {
    const media = await startAuto([makeItem(1), makeItem(2)]);
    const play = player(media, media.first()!, 240);
    const realStart = Date.now();
    await play(100_000);
    vi.setSystemTime(Date.now() - 5_000);
    await play(1_000);
    const realElapsed = Date.now() + 5_000 - realStart;
    const shown = Date.now() - lastState().startedAt;
    expect(Math.abs(shown - realElapsed)).toBeLessThan(1_000); // used to: 5 s short
  }, 30_000);

  it("a paused show's total does not lose it either", async () => {
    await startAuto([makeItem(1, { kind: "mc", duration_seconds: 300 }), makeItem(2)], false);
    const realStart = Date.now();
    await tick(30_000);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    await tick(10_000);
    vi.setSystemTime(Date.now() - 5_000);
    await tick(1_000);
    expect(lastState().running).toBe(false);
    const realElapsed = Date.now() + 5_000 - realStart;
    expect(Math.abs(Date.now() - lastState().startedAt - realElapsed)).toBeLessThan(1_000);
  }, 30_000);

  // Argon on hunt 13: a stamp made AFTER the step is already on the new clock. START pressed
  // between the step and the next tick was taken as begun before it - the row was pushed forward
  // by the whole step, and AUTO cut the first song 30 s early.
  it("START pressed just after the step, before the next tick: nothing moves, the song plays to its end", async () => {
    const set = [makeItem(1), makeItem(2)];
    const media = instrumentMediaElements();
    h.saved = set.map((it) => ({ itemId: it.id, blob: new Blob([it.id]), name: `${it.id}.wav`, path: null }));
    supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Clock"
        items={set}
        songAudio={{}}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    await act(async () => {});
    await act(async () => live().setStatus("SUBSCRIBED"));
    await act(async () => void vi.advanceTimersByTime(2_000));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/ })));
    await act(async () => void vi.advanceTimersByTime(500)); // a tick: nothing begun yet
    vi.setSystemTime(Date.now() - 30_000); // the time sync, 100 ms before START
    await act(async () => void vi.advanceTimersByTime(100));
    await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
    const begun = lastState().itemStartedAt;
    const play = player(media, media.first()!, 240);
    await play(230_000); // the first tick after START reads the whole step as a negative gap
    expect(lastState().itemStartedAt).toBe(begun);
    expect(lastState().currentIndex).toBe(0); // used to: AUTO on row 2 with 30 s of song 1 left
    await play(11_000);
    expect(lastState().currentIndex).toBe(1);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 60_000);
});
