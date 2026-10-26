// The 2026-10-26 final hunt's Live Mode findings (livecore). Each test failed on 86caa0d
// because of the bug it names. Harness copied from components/event/live-mode.test.tsx (same seams: the supabase
// client, the per-event audio store, the media-element instrumentation).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  fail,
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
const SNAPSHOT_KEY = `cueiq:live:${EVENT_ID}`;

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

const holdAll = (items: SetlistItem[]) =>
  items.map((it) => ({ itemId: it.id, blob: new Blob([it.id]), name: `${it.id}.wav`, path: null }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok([]), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
  // jsdom draws no frames: each fade lands on its first one (as live-mode.test.tsx does)
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now() + 60_000), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// P1. AUTO → MANUAL inside a Loop row's end-fade leaves the MC's bed SILENT.
// live-mode.tsx ~4335-4366: the end-fade arms only in Auto, but it is undone only when the
// row stops sounding or the show pauses. Switching to MANUAL in the last 3 s (the operator
// sees "เข้าใน 3 2 1" and the MC is still talking - exactly when MANUAL is pressed) lets the
// fade run on to 0, and the bed loops on at 0 for as long as the MC talks.
// ─────────────────────────────────────────────────────────────────────────────
describe("P1 · a Loop bed switched to MANUAL during its end-fade", () => {
  it("keeps its level in MANUAL (the bed loops on under the MC, as Manual promises)", async () => {
    const set = [
      makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 240 }),
    ];
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(set);
    await startShowFromUi();
    const primary = media.first()!;
    expect(media.state(primary).volume).toBeCloseTo(0.3); // the MC's bed at the MC level
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(8_500); // the MC is still talking: inside the last 3 s, the count is on
    // the operator holds the show: MANUAL
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Manual$/ }));
    });
    await tick(6_000); // the MC talks on past the slot
    expect(media.state(primary).paused).toBe(false);
    // used to: the end-fade ran on to 0 - the bed loops on, silent
    expect(media.state(primary).volume).toBeCloseTo(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2. A reload in MANUAL with the next row CUED: the song that was on the PA cannot be
// brought back - "แตะเพื่อเล่นเสียงต่อ" needs state.running (live-mode.tsx ~3223-3234), and a
// Manual cue is running:false while the committed song sounds. RUN then starts the CUED row.
// ─────────────────────────────────────────────────────────────────────────────
describe("P2 · reload while a Manual cue waits and the song before it plays", () => {
  it("offers the one-tap resume of the song that was sounding", async () => {
    const set = [makeItem(1), makeItem(2), makeItem(3)];
    instrumentMediaElements();
    h.saved = holdAll(set);
    const savedAt = Date.now() - 5_000; // a crash five seconds ago
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        // NEXT cued row 2 (frozen at 0:00) while row 1 plays on - the usual Manual move
        state: {
          running: false,
          begun: true,
          startedAt: savedAt - 120_000,
          itemStartedAt: null,
          itemElapsedAtPause: 0,
          currentIndex: 1,
          mode: "manual",
        },
        // row 1 sounding, 60 s in
        committed: { id: "item-1", anchor: savedAt - 60_000 },
        ended: false,
        isController: true,
        controllerSince: savedAt - 120_000,
        savedAt,
      })
    );
    await mountLive(set);
    await tick(3_000);
    // used to: no banner - the PA is silent and nothing offers row 1 back
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3. เล่นซ้อน (Auto) out of a row whose FILE is longer than its slot - an MC's 5-minute BGM
// in a 2:30 slot, a song cut short: overlapSwap (live-mode.tsx ~3499-3518) leaves the outgoing
// element playing "to its own end", which is the FILE's end, not the row's. The bed / the cut
// song plays on for minutes under the next song; nothing stops the tail at its row's end.
// ─────────────────────────────────────────────────────────────────────────────
describe("P3 · the overlap tail of a row cut shorter than its file", () => {
  it("stops when its row's time is over (lead seconds after the next came in)", async () => {
    const set = [
      // an MC's BGM: a 300 s file in a 150 s slot, not a Loop (it is long enough)
      makeItem(1, { kind: "mc", title: "MC", duration_seconds: 150 }),
      makeItem(2, { duration_seconds: 240, buffer_before_seconds: -5 }),
    ];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    const first = media.first()!;
    media.set(first, { duration: 300 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(145_250); // row 1 runs 145 s, then row 2 comes in over its last 5
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(1);
    media.set(first, { currentTime: 145 });
    await tick(20_000); // 15 s past the end of row 1's own 150 s
    // used to: the BGM is still playing under the song (155 s of file left)
    expect(media.state(first).paused).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4. STAGE's level slider (the NOW card's "ความดัง", an <input type=range>) keeps the focus
// after the operator rides it with the mouse, and the show keys then do nothing: the window
// handler returns for EVERY INPUT (live-mode.tsx ~4413-4416 "Ignored while typing in a field"),
// so Space (RUN / PAUSE) and N / → (NEXT) are dead until something else is clicked - and the
// browser turns ← / → into ±1 % on the slider. CONSOLE's fader was built to avoid exactly this
// (console-board.tsx Fader: "an operator pressing → for the next song must get the next song").
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 · the show keys after riding STAGE's level slider", () => {
  const keydown = (target: EventTarget, init: KeyboardEventInit) => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  };
  it("Space still pauses / runs the show", async () => {
    const set = [makeItem(1), makeItem(2), makeItem(3)];
    instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    await tick(1_000); // past START's settle
    // the NOW card's slider (the first of the two with this title; Live tools' copy is hidden)
    const slider = screen.getAllByTitle("ความดังของแทร็คนี้ (ตั้งล่วงหน้าได้)")[0] as HTMLInputElement;
    expect(slider.type).toBe("range");
    slider.focus(); // a mouse drag on it leaves it focused (Chromium)
    const before = stateSends().length;
    keydown(slider, { code: "Space", key: " " });
    // used to: nothing - the show runs on, the operator's PAUSE did not happen
    expect(stateSends().length).toBe(before + 1);
    expect(stateSends().at(-1)!.payload.running).toBe(false);
  });
  it("N still cues the next row (Manual)", async () => {
    const set = [makeItem(1), makeItem(2), makeItem(3)];
    instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    await tick(1_000);
    const slider = screen.getAllByTitle("ความดังของแทร็คนี้ (ตั้งล่วงหน้าได้)")[0] as HTMLInputElement;
    slider.focus();
    keydown(slider, { key: "n", code: "KeyN" });
    // used to: still on row 1
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5. After a reload, the ONLY tap an Auto show gets is "แตะเพื่อเล่นเสียงต่อ" (resumeAudio,
// live-mode.tsx ~3963-3983) - and it unlocks the primary only. primeSecondaryAudio() runs in
// START / RUN / a pad (~3003, 3769, 4042), never here. WebKit grants play() per ELEMENT
// (primeSecondaryAudio's own comment), so on an iPad Auto's next เล่นซ้อน starts the next row on
// a spare that never played in a tap: refused from the timer - that row is silent until a
// second tap. Same yardstick as live-pads-audio.test.tsx's P5.
// ─────────────────────────────────────────────────────────────────────────────
describe("P5 · reload in Auto, one tap to bring the sound back, then เล่นซ้อน", () => {
  it("the element Auto's overlap starts the next row on has played inside a tap before", async () => {
    const set = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 60, buffer_before_seconds: -5 }),
    ];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    const savedAt = Date.now() - 1_000; // a refresh a second ago
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        state: {
          running: true,
          begun: true,
          startedAt: savedAt - 60_000,
          itemStartedAt: savedAt,
          itemElapsedAtPause: null,
          currentIndex: 0,
          mode: "auto",
        },
        committed: { id: "item-1", anchor: savedAt },
        ended: false,
        isController: true,
        controllerSince: savedAt - 60_000,
        savedAt,
      })
    );
    await mountLive(set);
    const banner = screen.getByText(/แตะเพื่อเล่นเสียงต่อ/);
    await act(async () => {
      fireEvent.click(banner); // the operator's one tap
    });
    const callsAtTap = media.calls.length;
    await tick(5_000); // row 1 runs 5 s (10 less the next row's 5): row 2 comes in over it
    expect(stateSends().at(-1)?.payload.currentIndex ?? 1).toBe(1);
    const started = media.calls.filter((c) => c.type === "play").at(-1)!;
    const incoming = started.element;
    expect(String(media.state(incoming).src)).toMatch(/^blob:/);
    expect(incoming).not.toBe(media.first()); // the spare
    const playedInATap = media.calls.slice(0, callsAtTap).some((c) => c.element === incoming && c.type === "play");
    // used to: the spare has never played - an iPad refuses this play() from Auto's timer
    expect(playedInATap).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P6. A Loop turned on OFFLINE ("ออฟไลน์ — ตั้งเล่นวนไว้เฉพาะเครื่องนี้", live-mode.tsx ~2403-2409:
// "the flag stands on this device, because looping the BGM is something the show needs NOW")
// is thrown away by the first re-read once the network is back (the 'online' handler, the
// SUBSCRIBED handler, any setlist-changed): refetchItems replaces the rows wholesale and nothing
// lays the local flag back on top - the offline reorder has pendingOrderRef for exactly this,
// the Loop flag has nothing. The bed stops looping mid-MC and runs out into silence.
// ─────────────────────────────────────────────────────────────────────────────
describe("P6 · a Loop set offline, then the venue Wi-Fi comes back", () => {
  it("the MC's bed keeps looping after the reconnect re-read", async () => {
    const set = [makeItem(1, { kind: "mc", title: "MC BGM", duration_seconds: 120 }), makeItem(2)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    const primary = media.first()!;
    // the venue Wi-Fi drops
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    supa.setScript({
      setlist_items: (call) => (call.verb === "update" ? fail("Failed to fetch", 0) : ok(set)),
      songs: ok([]),
      show_authority: ok([]),
    });
    await act(async () => {
      fireEvent.click(screen.getAllByTitle(/^Loop ปิด/)[0]); // Loop on for the sounding bed
    });
    await act(async () => {});
    expect(primary.loop).toBe(true); // it stands on this device, as the toast says
    // the Wi-Fi comes back: the page re-reads the setlist (server row: loop_audio false)
    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {});
    // used to: the re-read put loop_audio=false back - the bed plays to its end, then silence
    expect(primary.loop).toBe(true);
    onLine.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P7. Desktop, the show routed to the USB interface (Live tools → เสียงออกที่). The cable drops
// out for a moment (a knock, a hub reset) and goes back in. audio-output-picker.tsx ~73-83 snaps
// the choice to "" the moment the device vanishes, and live-mode.tsx ~1094-1101 WRITES that ""
// over the saved choice (cueiq:audioSink). Nothing remembers the interface: when it is back the
// show stays on the system default - the laptop's own speaker - until someone finds Live tools,
// and the next show opens there too. (The same when Live is opened before the interface is
// plugged in.)
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 · the chosen output drops out and comes back", () => {
  const asked: Array<{ el: HTMLMediaElement; id: string }> = [];
  let outputs: Array<{ deviceId: string; kind: string; label: string }>;
  let md: EventTarget & { enumerateDevices: () => Promise<unknown[]> };
  beforeEach(() => {
    asked.length = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      writable: true,
      value: function (this: HTMLMediaElement, id: string) {
        asked.push({ el: this, id });
        return Promise.resolve();
      },
    });
    outputs = [
      { deviceId: "default", kind: "audiooutput", label: "Default - MacBook Pro Speakers" },
      { deviceId: "builtin-1", kind: "audiooutput", label: "MacBook Pro Speakers" },
      { deviceId: "usb-1", kind: "audiooutput", label: "USB Audio Interface" },
    ];
    md = Object.assign(new EventTarget(), { enumerateDevices: async () => outputs.map((d) => ({ ...d })) });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: md });
    (window as unknown as { cueiqNative?: unknown }).cueiqNative = {
      setUnloadReason: async () => {},
      setShowRunning: async () => {},
    };
  });
  afterEach(() => {
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).setSinkId;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
  });

  it("the show goes back to the interface once it is plugged in again, and the choice is kept", async () => {
    localStorage.setItem("cueiq:audioSink", "usb-1");
    const set = [makeItem(1), makeItem(2)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await act(async () => {});
    await startShowFromUi();
    const primary = media.first()!;
    expect(asked.filter((a) => a.el === primary).at(-1)?.id).toBe("usb-1");
    // the cable drops out...
    outputs = outputs.filter((d) => d.deviceId !== "usb-1");
    await act(async () => {
      md.dispatchEvent(new Event("devicechange"));
    });
    await act(async () => {});
    // (the snap to the default keeps the show audible - as designed)
    expect(asked.filter((a) => a.el === primary).at(-1)?.id).toBe("");
    // ...and goes back in
    outputs = [...outputs, { deviceId: "usb-1", kind: "audiooutput", label: "USB Audio Interface" }];
    await act(async () => {
      md.dispatchEvent(new Event("devicechange"));
    });
    await act(async () => {});
    await tick(1_000);
    // used to: the interface is forgotten - the show plays on out of the laptop speaker
    expect(localStorage.getItem("cueiq:audioSink")).toBe("usb-1");
    expect(asked.filter((a) => a.el === primary).at(-1)?.id).toBe("usb-1");
  });
});

// P2b. The same gap without a reload: a Manual cue waits (NEXT pressed, RUN not yet) and the OS
// pauses the song still on the PA (a headset unplugged, a media key, Control Centre on an iPad).
// The 'pause' listener (~1011-1031) clears audioPlaying for exactly this - but the banner it is
// meant to raise is gated on state.running, which a Manual cue never has.
describe("P2b · the OS pauses the sounding song while a Manual cue waits", () => {
  it("offers the one-tap resume", async () => {
    const set = [makeItem(1), makeItem(2), makeItem(3)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    await tick(1_000);
    const primary = media.first()!;
    media.emit(primary, "playing");
    // NEXT: row 2 cued, row 1 plays on
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    expect(media.state(primary).paused).toBe(false);
    // the OS pauses it
    media.set(primary, { paused: true });
    media.emit(primary, "pause");
    await tick(1_000);
    // used to: no banner; the dock's key says Run and would start row 2 instead
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).not.toBeNull();
  });
});

// controls (GREEN on 86caa0d): the same moves without the trigger - the probes above are honest
describe("controls", () => {
  it("P2b control: the OS pause with NO cue pending raises the banner", async () => {
    const set = [makeItem(1), makeItem(2), makeItem(3)];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    await tick(1_000);
    const primary = media.first()!;
    media.emit(primary, "playing");
    media.set(primary, { paused: true });
    media.emit(primary, "pause");
    await tick(1_000);
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).not.toBeNull();
  });
  it("P1 control: Manual all along - the bed keeps its level past the slot", async () => {
    const set = [
      makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 240 }),
    ];
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(set);
    await startShowFromUi();
    await tick(16_000);
    expect(media.state(media.first()!).volume).toBeCloseTo(0.3);
  });
  it("P3 control: a row whose file ends with its slot - the tail is its last 5 s", async () => {
    const set = [
      makeItem(1, { kind: "mc", title: "MC", duration_seconds: 150 }),
      makeItem(2, { duration_seconds: 240, buffer_before_seconds: -5 }),
    ];
    const media = instrumentMediaElements();
    h.saved = holdAll(set);
    await mountLive(set);
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(145_250);
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(1);
    // the incoming row is on the spare, the outgoing still sounds (its last seconds)
    expect(media.state(media.first()!).paused).toBe(false);
  });
});
