// SET MIXER's pads - the show's state around them: a cue and GO, -> AUTO after a green pad, what
// the viewers are told, a reload, a tab that gives way, reset and จบโชว์ with layers sounding.
// Found by the 2026-10-25 bug hunt (six reviewers, each finding proven by a test that failed on
// a003fe0), kept as the regression suite for what it found. Harness as components/event/live-mode.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
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

const ITEMS = [makeItem(1), makeItem(2), makeItem(3)];
let supa: SupabaseFake;

function renderLive(over: Partial<React.ComponentProps<typeof LiveMode>> = {}) {
  return render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Pads"
      items={ITEMS}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
      {...over}
    />
  );
}
function live(): ChannelFake {
  const ch = supa.channels.filter((c) => c.name === TOPIC).at(-1) ?? supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
function stateSends(ch = live()) {
  return ch.sent.filter((s) => s.event === "state");
}
async function mountLive(over: Parameters<typeof renderLive>[0] = {}) {
  const view = renderLive(over);
  await act(async () => {});
  return view;
}
function pressKey(target: EventTarget, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
}
async function startShowFromUi(): Promise<number> {
  await act(async () => {
    live().setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  const first = stateSends()[0];
  expect(first).toBeTruthy();
  return first.payload.startedAt as number;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  localStorage.clear();
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok(ITEMS), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LiveMode pads · state, viewers and the snapshot", () => {
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
    vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.removeItem("cueiq:liveView");
  });

  async function startPads(set = SET, withFile: (it: SetlistItem) => boolean = () => true) {
    const media = instrumentMediaElements();
    supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
    h.saved = set.filter(withFile).map((it) => ({
      itemId: it.id,
      blob: Object.assign(new Blob([it.id]), { row: it.id }),
      name: `${it.id}.wav`,
      path: null,
    }));
    await mountLive({ items: set });
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

  it("START plays row 1 and a pad makes row 3 NOW", async () => {
    const media = await startPads();
    expect(playing(media, "item-1")).toHaveLength(1);
    await tick(1_000);
    await press(3);
    expect(last()).toMatchObject({ currentIndex: 2, running: true });
    expect(playing(media, "item-3")).toHaveLength(1);
  });

  // P1 ─ a tile fader touched while Auto Mute takes NOW down cancels Auto Mute's fade on NOW
  it("Auto Mute, then any tile's fader: NOW still goes to silence", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3); // NOW = Track 3, Track 1 under it
    const [three] = playing(media, "item-3");
    expect(three).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    });
    await tick(1_000); // a third of the way down
    // the operator nudges another tile's fader (row 5) - e.g. sets the next song while the show ends
    const fader5 = screen.getAllByTestId("console-tile-fader")[4];
    fireEvent.keyDown(fader5, { key: "ArrowDown" });
    await tick(3_500);
    // the layer (Track 1) went to silence on its own fade...
    expect(playing(media, "item-1")).toEqual([]);
    // ...and NOW, which Auto Mute was taking down, must be silent too
    expect(media.state(three).volume).toBeLessThan(0.01);
  });

  // P2 ─ a green pad on the sounding row while another row is cued, then AUTO
  it("cue row 2, fade row 1 by its green pad, switch to AUTO: the faded song stays out and the show stays on row 2", async () => {
    const media = await startPads();
    await tick(10_000);
    pressKey(window, { key: "ArrowRight", code: "ArrowRight" }); // cue Track 2; Track 1 plays on
    expect(last()).toMatchObject({ currentIndex: 1, running: false });
    expect(pad(1)).toHaveAttribute("data-state", "on");
    await press(1); // Track 1's green pad: fade it out
    expect(pad(1)).toHaveAttribute("data-state", "fade");
    await tick(3_250);
    expect(playing(media, "item-1")).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    // nothing was sounding: the song faded out by hand must stay out, the show must not jump back to it
    const back = playing(media, "item-1").map((el) => ({ at: media.state(el).currentTime, vol: media.state(el).volume }));
    expect({ back, now: last().currentIndex }).toEqual({ back: [], now: 1 });
  });

  // P3 ─ a pad on a row with no file: the controller's pad and the viewers' disagree
  it("a file-less pad: the controller shows it ready, and the wire does not call it sounding", async () => {
    const set = [
      makeItem(1, { duration_seconds: 200 }),
      makeItem(2, { kind: "mc", title: "MC talk", duration_seconds: 60 }),
      makeItem(3, { duration_seconds: 200 }),
    ];
    await startPads(set, (it) => it.id !== "item-2");
    await tick(2_000);
    await press(2); // the MC talk: no file, Track 1 plays on under it
    expect(last()).toMatchObject({ currentIndex: 1, running: true });
    const ctrlState = pad(2).getAttribute("data-state");
    const p = last();
    // what a viewer would compute: remoteAudio playing item-2, pads.ended not item-2 → lit "on"
    const viewerLit = p.audioPlaying === true && p.audioItemId === "item-2" && p.pads?.ended !== "item-2";
    expect({ ctrlState, viewerLit }).toEqual({ ctrlState: "ready", viewerLit: false });
  });

  // P3b ─ confirm on a real viewer page
  it("a viewer fed that payload shows the file-less MC pad as the controller does", async () => {
    const set = [
      makeItem(1, { duration_seconds: 200 }),
      makeItem(2, { kind: "mc", title: "MC talk", duration_seconds: 60 }),
      makeItem(3, { duration_seconds: 200 }),
    ];
    await startPads(set, (it) => it.id !== "item-2");
    await tick(2_000);
    await press(2);
    const p = { ...last(), sender: "pa-device" };
    const ctrl = pad(2).getAttribute("data-state");
    cleanup();
    h.saved = [];
    await mountLive({ items: set });
    await act(async () => {
      live().emit("state", { ...p, sentAt: Date.now() });
    });
    const viewer = pad(2).getAttribute("data-state");
    expect({ ctrl, viewer }).toEqual({ ctrl, viewer: ctrl });
  });

  // P4 ─ a cued row is skipped by GO / Enter
  it("→ cues row 2: Enter/GO fires row 2, never skips it", async () => {
    await startPads();
    await tick(10_000);
    pressKey(window, { key: "ArrowRight", code: "ArrowRight" }); // cue Track 2
    expect(last()).toMatchObject({ currentIndex: 1, running: false });
    const goText = screen.getByTestId("console-go").textContent;
    pressKey(window, { key: "Enter", code: "Enter" });
    expect({ goText: goText?.includes("Track 2"), now: last().currentIndex }).toEqual({ goText: true, now: 1 });
  });

  // P5 ─ NOW's file ends by itself: nothing tells the viewers its pad is no longer lit
  it("NOW's file ends on its own: its pad goes grey and a message tells the viewers", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    const [three] = playing(media, "item-3");
    const sent = stateSends().length;
    media.set(three, { ended: true, paused: true });
    await act(async () => {
      media.emit(three, "ended");
    });
    expect(pad(3)).toHaveAttribute("data-state", "played");
    // a viewer still lights pad 3 green ("−0:00") until the next state message
    expect(stateSends().length).toBeGreaterThan(sent);
  });

  // P6 ─ a layer's tile fader: the viewers' copy of the layer level is never told
  it("a layer's tile fader reaches the viewers in a state message", async () => {
    await startPads();
    await tick(1_000);
    await press(3); // Track 1 under, at 100
    const fader1 = screen.getAllByTestId("console-tile-fader")[0];
    for (let i = 0; i < 5; i++) fireEvent.keyDown(fader1, { key: "ArrowDown" });
    await tick(500);
    expect(fader1).toHaveAttribute("aria-valuenow", "95");
    const l1 = (last().pads.layers as Array<{ id: string; level: number }>).find((l) => l.id === "item-1");
    expect(l1?.level).toBe(95);
  });

  // P12 ─ the same run on two tabs: this (later-opened) tab yields while pads sound → silent
  it("a tab that yields to the first tab of the same run stops every element, layers included", async () => {
    const mountedAt = Date.now();
    const media = await startPads();
    const run = last().controllerSince as number;
    await tick(1_000);
    await press(3);
    await tick(1_000);
    await press(5);
    expect(playing(media, "item-1")).toHaveLength(1);
    expect(playing(media, "item-3")).toHaveLength(1);
    const t = Date.now();
    await act(async () => {
      live().emit("state", {
        sender: "first-tab",
        sentAt: t,
        fromController: true,
        begun: true,
        running: true,
        startedAt: run,
        itemStartedAt: t - 2_000,
        itemElapsedAtPause: null,
        currentIndex: 4,
        currentItemId: "item-5",
        mode: "manual",
        controllerSince: run,
        openedAt: mountedAt - 60_000,
        ended: false,
        audioItemId: "item-5",
        audioPlaying: true,
        audioAnchor: t - 2_000,
      });
    });
    await tick(500);
    const sounding = media.elements.filter((el) => !media.state(el).paused && media.state(el).src.startsWith("blob:"));
    expect(sounding).toEqual([]);
  });

  // P7 ─ WebKit (iPad / iPhone) grants play() per ELEMENT, only to one first played inside a tap
  // (live-mode.tsx primeSecondaryAudio's own comment). Emulated: an element's play() outside a
  // tap is refused unless that element already played inside one.
  function webkitGesturePolicy() {
    const proto = HTMLMediaElement.prototype;
    const inner = proto.play;
    const unlocked = new WeakSet<HTMLMediaElement>();
    const refused: string[] = [];
    let gesture = false;
    proto.play = function (this: HTMLMediaElement) {
      if (gesture) unlocked.add(this);
      if (!unlocked.has(this)) {
        refused.push(this.src);
        return Promise.reject(new DOMException("play() blocked", "NotAllowedError"));
      }
      return inner.call(this);
    };
    const tap = async (el: Element) => {
      await act(async () => {
        gesture = true;
        try {
          fireEvent.click(el);
        } finally {
          gesture = false;
        }
      });
    };
    return { refused, tap };
  }

  it("iPad: Auto Mute during Auto's overlap tail - the next overlap still plays (its element was unlocked in a tap)", async () => {
    const set = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 30, buffer_before_seconds: -5 }),
      makeItem(3, { duration_seconds: 60, buffer_before_seconds: -5 }),
    ];
    const media = instrumentMediaElements();
    const policy = webkitGesturePolicy();
    supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
    h.saved = set.map((it) => ({ itemId: it.id, blob: Object.assign(new Blob([it.id]), { row: it.id }), name: "x.wav", path: null }));
    await mountLive({ items: set });
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await policy.tap(screen.getByTestId("start-show"));
    await act(async () => {});
    expect(playing(media, "item-1")).toHaveLength(1);
    await policy.tap(screen.getByRole("button", { name: /^Auto$/ }));
    await tick(5_250); // Track 2 comes in over Track 1's last 5 s (the spare, unlocked at START)
    expect(last().currentIndex).toBe(1);
    expect(playing(media, "item-1")).toHaveLength(1); // the tail
    expect(policy.refused).toEqual([]);
    await policy.tap(screen.getByRole("button", { name: "Mute" })); // Auto Mute during the tail
    // the operator brings the music back and the show goes on in AUTO
    await policy.tap(screen.getByRole("button", { name: /LOUD|Loud/ }));
    await tick(25_500); // Track 2's 30 s less Track 3's 5 s lead: Auto brings Track 3 in over it
    expect(last().currentIndex).toBe(2);
    expect({ refused: policy.refused, three: playing(media, "item-3").length }).toEqual({ refused: [], three: 1 });
  });

  // P8 ─ NOW faded out by its own green pad, then the page crashes / reloads
  it("after NOW's green pad a reload comes back with its sound over: no 'tap to resume', the song stays out", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    await tick(20_000);
    await press(3); // NOW's own green pad - the operator ends this song's sound, the row stays on
    await tick(3_250);
    expect(playing(media, "item-3")).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide")); // the snapshot flush a reload/crash gets
    });
    cleanup();
    await mountLive({ items: SET });
    const banner = screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/);
    let after: string[] = [];
    if (banner) {
      await act(async () => {
        fireEvent.click(banner.closest("button")!);
      });
      after = media.elements.filter((el) => !media.state(el).paused && media.state(el).src === "blob:item-3").map((el) => String(media.state(el).currentTime));
    }
    expect({ banner: !!banner, after }).toEqual({ banner: false, after: [] });
  });

  // ── sound checks (expected to PASS) ──
  it("reset with layers sounding and fading stops every element; no state goes out after the reset", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    await tick(1_000);
    await press(5);
    await press(1); // Track 1 starts fading
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    confirm.mockRestore();
    const sent = stateSends().length;
    expect(last().begun).toBe(false);
    expect(last().pads).toBeUndefined();
    await tick(4_000);
    for (const el of media.elements) {
      if (media.state(el).src.startsWith("blob:")) expect(media.state(el).paused).toBe(true);
    }
    expect(stateSends().length).toBe(sent);
  });

  it("จบโชว์ while cued with layers: everything stops, the payload has no layers and no sounding row", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    await tick(1_000);
    pressKey(window, { key: "ArrowRight", code: "ArrowRight" }); // cue row 4
    expect(last()).toMatchObject({ currentIndex: 3, running: false });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    for (const el of media.elements) {
      if (media.state(el).src.startsWith("blob:")) expect(media.state(el).paused).toBe(true);
    }
    expect(last().pads.layers).toEqual([]);
    expect(last().audioPlaying).toBe(false);
  });

  it("pad, AUTO, MANUAL: layers keep sounding, pads unlock, NOW kept", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(1_000);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Manual$/ }));
    });
    expect(last()).toMatchObject({ mode: "manual", currentIndex: 2, running: true });
    expect(playing(media, "item-1")).toHaveLength(1);
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(pad(5)).not.toBeDisabled();
  });

  it("the same show without the Auto Mute: the emulated policy lets Track 3 in (the emulation is honest)", async () => {
    const set = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 30, buffer_before_seconds: -5 }),
      makeItem(3, { duration_seconds: 60, buffer_before_seconds: -5 }),
    ];
    const media = instrumentMediaElements();
    const policy = webkitGesturePolicy();
    supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
    h.saved = set.map((it) => ({ itemId: it.id, blob: Object.assign(new Blob([it.id]), { row: it.id }), name: "x.wav", path: null }));
    await mountLive({ items: set });
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await policy.tap(screen.getByTestId("start-show"));
    await act(async () => {});
    await policy.tap(screen.getByRole("button", { name: /^Auto$/ }));
    await tick(5_250);
    await policy.tap(screen.getByRole("button", { name: /LOUD|Loud/ }));
    await tick(25_500);
    expect(last().currentIndex).toBe(2);
    expect({ refused: policy.refused, three: playing(media, "item-3").length }).toEqual({ refused: [], three: 1 });
  });
});
