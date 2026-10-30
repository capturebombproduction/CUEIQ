// The PA laptop's physical world (2026-10-30, hunt 12). What used to go wrong:
// · The lid closed or Windows slept under a running show. The row's clock is wall time, the file
//   is not: 30 s asleep at 1:00 of a 4:00 song and AUTO cut the song 30 s before its end; 5 min
//   asleep and the next song started by itself the moment the lid opened, with no word on screen.
// · The sounding element died with a media error mid-song (the picked USB interface pulled:
//   Chromium's AUDIO_RENDERER_ERROR). It stays paused=false, so audioPlaying stayed true: no
//   rescue banner, and PAUSE + RUN (what the Stalled alarm says) played the same dead element.
//   The PA stayed silent to the next row, with the cable back in.
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
  stateSends().at(-1)!.payload as { currentIndex: number; itemStartedAt: number; startedAt: number };
async function mountLive(items: SetlistItem[]) {
  supa.setScript({ setlist_items: ok(items), songs: ok([]), show_authority: ok([]) });
  render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Machine"
      items={items}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
}
async function startShow() {
  await act(async () => live().setStatus("SUBSCRIBED"));
  await act(async () => void vi.advanceTimersByTime(2_000));
  await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
}
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) await act(async () => void vi.advanceTimersByTime(250));
};
const holdAll = (items: SetlistItem[]) =>
  items.map((it) => ({ itemId: it.id, blob: new Blob([it.id]), name: `${it.id}.wav`, path: null }));
const goAuto = () => act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/ })));
/** The machine slept: the wall clock jumped, no timer ran. */
const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
const setVisibility = (v: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
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

describe("LiveMode · the machine slept under a running show", () => {
  async function songAtOneMinute(set: SetlistItem[]) {
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShow();
    await goAuto();
    const song = media.first()!;
    await tick(60_000);
    media.set(song, { duration: 240, currentTime: 60 });
    return { media, song };
  }

  it("a 30 s sleep: the song keeps its last 30 s, and AUTO leaves it at its own end", async () => {
    const { media, song } = await songAtOneMinute([makeItem(1), makeItem(2)]);
    sleep(30_000); // the file comes back at 1:00
    await tick(1_000);
    expect(h.toast.warning).toHaveBeenCalledTimes(1); // and the operator is told
    await tick(148_000);
    media.set(song, { currentTime: 210 });
    await tick(1_000);
    expect(lastState().currentIndex).toBe(0); // used to: gone, 30 s before the song's end
    await tick(30_000);
    media.set(song, { currentTime: 240 });
    await tick(1_000);
    expect(lastState().currentIndex).toBe(1);
  }, 30_000);

  it("a 20 min sleep: nothing starts by itself when the lid opens, and the show's total stays real", async () => {
    await songAtOneMinute([makeItem(1), makeItem(2), makeItem(3)]);
    const startedAt = lastState().startedAt;
    sleep(1_200_000);
    await tick(2_000);
    expect(lastState().currentIndex).toBe(0);
    expect(lastState().startedAt).toBe(startedAt);
  }, 30_000);

  it("a row with no file: its time does not count the sleep, on a visible page", async () => {
    const set = [makeItem(1, { kind: "mc", duration_seconds: 120 }), makeItem(2)];
    await mountLive(set);
    await startShow();
    await goAuto();
    await tick(10_000);
    const before = lastState().itemStartedAt;
    sleep(300_000);
    await tick(1_000);
    expect(lastState().currentIndex).toBe(0); // the song after it did not start by itself
    expect(lastState().itemStartedAt).toBeGreaterThan(before + 299_000);
  }, 30_000);

  it("a hidden tab's throttled ticks leave a row with no file alone: its wall clock is right", async () => {
    const set = [makeItem(1, { kind: "mc", duration_seconds: 120 }), makeItem(2)];
    await mountLive(set);
    await startShow();
    await goAuto();
    await tick(10_000);
    const sends = stateSends().length;
    setVisibility("hidden");
    sleep(60_000);
    await tick(1_000);
    expect(stateSends().length).toBe(sends);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a hidden page with the file moved on with the clock: nothing moved, nothing said", async () => {
    const { song, media } = await songAtOneMinute([makeItem(1), makeItem(2)]);
    const sends = stateSends().length;
    setVisibility("hidden");
    sleep(30_000);
    media.set(song, { currentTime: 90 }); // a phone's audio plays on while its JS is frozen
    await tick(1_000);
    expect(stateSends().length).toBe(sends);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a hidden page with a file that really stopped: the file is the truth, without a toast", async () => {
    await songAtOneMinute([makeItem(1), makeItem(2)]);
    setVisibility("hidden");
    const before = lastState().itemStartedAt;
    sleep(30_000);
    await tick(1_000);
    expect(lastState().itemStartedAt).toBeGreaterThan(before + 29_000);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a Loop row is not re-anchored to its file, which goes round: it shifts by the gap", async () => {
    const set = [makeItem(1, { kind: "mc", loop_audio: true, duration_seconds: 300 }), makeItem(2)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShow();
    await goAuto();
    await tick(100_000);
    media.set(media.first()!, { duration: 60, currentTime: 40 }); // 100 s in, the file is at 0:40
    const before = lastState().itemStartedAt;
    sleep(30_000);
    await tick(1_000);
    const moved = lastState().itemStartedAt - before;
    expect(moved).toBeGreaterThan(29_000);
    expect(moved).toBeLessThan(31_000); // the file's 0:40 would have read as 90 s
  }, 30_000);

  it("a paused show is left alone", async () => {
    const set = [makeItem(1), makeItem(2)];
    instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShow();
    await tick(10_000);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    const sends = stateSends().length;
    sleep(60_000);
    await tick(1_000);
    expect(stateSends().length).toBe(sends);
    expect(h.toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("a viewer never re-anchors by itself", async () => {
    const set = [makeItem(1), makeItem(2)];
    await mountLive(set);
    await act(async () => live().setStatus("SUBSCRIBED"));
    const t = Date.now();
    await act(async () => {
      live().emit("state", {
        sender: "the-pa",
        sentAt: t,
        fromController: true,
        begun: true,
        running: true,
        startedAt: t - 60_000,
        itemStartedAt: t - 10_000,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "auto",
        controllerSince: t - 60_000,
        ended: false,
      });
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    sleep(60_000);
    await tick(1_000);
    expect(stateSends().length).toBe(0);
    expect(h.toast.warning).not.toHaveBeenCalled();
  });
});

describe("LiveMode · the sounding element died with a media error", () => {
  const RENDERER = { code: 3, message: "AUDIO_RENDERER_ERROR: audio error during playing" } as MediaError;
  async function dead(error: MediaError = RENDERER) {
    const set = [makeItem(1), makeItem(2)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShow();
    const song = media.first()!;
    await act(async () => media.emit(song, "playing"));
    await tick(95_000);
    media.set(song, { currentTime: 95, duration: 240, error }); // Chromium leaves paused=false
    await act(async () => media.emit(song, "error"));
    return { media, song };
  }
  const loads = (m: Awaited<ReturnType<typeof dead>>) =>
    m.media.callsFor(m.song).filter((c) => c.type === "src").length;

  it("brings up the rescue, and the rescue loads the file again at the show's position", async () => {
    const m = await dead();
    const before = loads(m);
    const rescue = screen.getByRole("button", { name: /แตะเพื่อเล่นเสียงต่อ/ });
    await act(async () => void fireEvent.click(rescue));
    expect(loads(m)).toBeGreaterThan(before);
    expect(m.media.state(m.song).currentTime).toBeCloseTo(95, 0);
    expect(m.media.state(m.song).error).toBeNull();
  }, 30_000);

  it("PAUSE then RUN loads the file again, at the position it was paused at", async () => {
    const m = await dead();
    const before = loads(m);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    await tick(500);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    expect(loads(m)).toBeGreaterThan(before);
    expect(m.media.state(m.song).currentTime).toBeCloseTo(95, 0);
  }, 30_000);

  it("a switch to AUTO loads it again too", async () => {
    const m = await dead();
    const before = loads(m);
    await goAuto();
    expect(loads(m)).toBeGreaterThan(before);
    expect(m.media.state(m.song).currentTime).toBeCloseTo(95, 0);
  }, 30_000);

  it("says the sound device went, not that the file is bad - and goes when the sound is back", async () => {
    const m = await dead();
    expect(screen.getByText(/อุปกรณ์เสียงหลุด/)).toBeInTheDocument();
    expect(screen.queryByText(/ลองโหลดไฟล์เพลงใหม่/)).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /แตะเพื่อเล่นเสียงต่อ/ })));
    await act(async () => m.media.emit(m.song, "playing"));
    expect(screen.queryByText(/อุปกรณ์เสียงหลุด/)).toBeNull();
  }, 30_000);

  it("a file that cannot play still says so", async () => {
    await dead({ code: 4, message: "DEMUXER_ERROR_NO_SUPPORTED_STREAMS" } as MediaError);
    expect(screen.getByText(/ลองโหลดไฟล์เพลงใหม่/)).toBeInTheDocument();
  }, 30_000);

  describe("a route change arrives (the picker, on the desktop app)", () => {
    let outputs: Array<{ deviceId: string; kind: string; label: string }>;
    let md: EventTarget & { enumerateDevices: () => Promise<unknown[]> };
    beforeEach(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
        configurable: true,
        writable: true,
        value: () => Promise.resolve(),
      });
      outputs = [
        { deviceId: "default", kind: "audiooutput", label: "Default - Speakers" },
        { deviceId: "spk", kind: "audiooutput", label: "Speakers" },
        { deviceId: "usb-1", kind: "audiooutput", label: "USB Audio Interface" },
      ];
      md = Object.assign(new EventTarget(), { enumerateDevices: async () => outputs.map((d) => ({ ...d })) });
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: md });
      (window as unknown as { cueiqNative?: unknown }).cueiqNative = {
        setUnloadReason: async () => {},
        setShowRunning: async () => {},
      };
      window.localStorage.setItem("cueiq:audioSink", "usb-1");
    });
    afterEach(() => {
      delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).setSinkId;
      delete (navigator as unknown as Record<string, unknown>).mediaDevices;
      delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
      window.localStorage.clear();
    });
    const pull = async () => {
      outputs = outputs.filter((d) => d.deviceId !== "usb-1");
      await act(async () => {
        md.dispatchEvent(new Event("devicechange"));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    it("heals a dead primary by itself, at the show's position", async () => {
      const m = await dead();
      const before = loads(m);
      await pull();
      expect(loads(m)).toBeGreaterThan(before);
      expect(m.media.state(m.song).currentTime).toBeCloseTo(95, 0);
      expect(m.media.state(m.song).error).toBeNull();
    }, 30_000);

    it("never reloads a healthy element", async () => {
      const set = [makeItem(1), makeItem(2)];
      const media = instrumentMediaElements();
      h.saved = holdAll(set);
      await mountLive(set);
      await startShow();
      const song = media.first()!;
      await tick(5_000);
      const before = media.callsFor(song).filter((c) => c.type === "src").length;
      await pull();
      expect(media.callsFor(song).filter((c) => c.type === "src").length).toBe(before);
    }, 30_000);

    it("leaves a dead element the operator has paused to RUN", async () => {
      const m = await dead();
      await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
      const before = loads(m);
      await pull();
      expect(loads(m)).toBe(before);
    }, 30_000);
  });
});
