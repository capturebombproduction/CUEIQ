// SET MIXER's pads - the life of an audio element: what a fader, a failed file, an outside pause,
// a library re-upload and an iPad's per-element play() rule do to the players under NOW.
// Found by the 2026-10-25 bug hunt (six reviewers, each finding proven by a test that failed on
// a003fe0), kept as the regression suite for what it found. Harness as components/event/live-mode.test.tsx.
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

describe("LiveMode pads · the harness", () => {
  it("a pad fires and the row before goes under", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    expect(playing(media, "item-1")).toHaveLength(1);
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(last()).toMatchObject({ currentIndex: 2, running: true });
  });
});

// ── P1: a tile fader on another row, touched while a key fade rides NOW ─────────────────────────
// setPadLevel → setVolumeFor → fadeVolumeFor(row, v, 0), whose first line cancels THE (global)
// key fade - whatever row it was riding. NOW stops part way down and plays on there.
describe("LiveMode pads · a tile fader leaves NOW's key fade alone", () => {
  it("Auto Mute on NOW still lands at 0 when another row's tile fader is touched mid-fade", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    const [three] = playing(media, "item-3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    });
    await tick(1_000);
    const mid = media.state(three).volume;
    expect(mid).toBeGreaterThan(0.02); // part way down
    // preset the next pad's level (row 5, not sounding) - one ↓ on its tile fader
    fireEvent.keyDown(screen.getAllByTestId("console-tile-fader")[4], { key: "ArrowDown" });
    await tick(3_000);
    // Auto Mute is how a show ends: NOW must reach silence
    expect(media.state(three).volume).toBeLessThan(0.01);
  });

  it("MC on NOW still lands at 30 when a layer's tile fader is touched mid-duck", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3); // Track 1 sounds under NOW (Track 3)
    const [three] = playing(media, "item-3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "MC" }));
    });
    await tick(500);
    fireEvent.keyDown(screen.getAllByTestId("console-tile-fader")[0], { key: "ArrowDown" }); // the layer's
    await tick(2_500);
    expect(media.state(three).volume).toBeCloseTo(0.3, 2);
  });
});

// ── P2: a NOW whose file failed goes under as a "sounding" layer ────────────────────────────────
// Chromium leaves `paused` false after a media error (no pause event, no ended): firePad's
// nowSounding reads it as sounding and goUnder makes the dead element a layer - a green pad that
// never ends, counted in the four, sent to every viewer, the STAGE chip counting it down.
describe("LiveMode pads · a NOW whose file failed is no layer", () => {
  it("the next pad does not keep a dead NOW lit as sounding", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    const [three] = playing(media, "item-3");
    // the file fails to decode / the blob dangles: error, and (as in Chromium) paused stays false
    await act(async () => {
      media.set(three, { error: { code: 4 } });
      media.emit(three, "error");
    });
    await tick(1_000);
    await press(5);
    expect(last().pads.layers.map((l: { id: string }) => l.id)).not.toContain("item-3");
    expect(pad(3)).not.toHaveAttribute("data-state", "on");
  });
});

// ── P4: a layer the browser paused by itself stays "sounding" ───────────────────────────────────
// Only the primary listens to `pause` (the rescue banner). A layer paused from outside (a media
// key, a headset button, an OS interruption) is never released: green forever, one of the four.
describe("LiveMode pads · a layer paused from outside is let go", () => {
  it("a layer paused by the browser is not shown, counted and broadcast as sounding", async () => {
    const media = await startPads();
    const first = media.first()!;
    await tick(2_000);
    await press(3);
    expect(pad(1)).toHaveAttribute("data-state", "on");
    await act(async () => {
      media.set(first, { paused: true });
      media.emit(first, "pause");
    });
    await tick(2_000);
    expect(pad(1)).not.toHaveAttribute("data-state", "on");
    expect(screen.getByTestId("console-pads-sounding").textContent).toContain("1");
  });
});

// ── P3: the on-air lock covers the primary only ─────────────────────────────────────────────────
// The download effect never revokes / drops the file of the row that sounds ("LOCK the on-air
// file: never re-download or revoke the track that's currently sounding") - but it asks only
// `it.id === playingIdRef.current`. A row sounding as a LAYER has its object URL revoked (and its
// IndexedDB copy deleted) by a mid-show swap or library re-upload while it still plays.
describe("LiveMode pads · a layer's file is on air too", () => {
  it("a mid-show swap of a row that sounds under NOW does not revoke the URL it plays", async () => {
    const A = { id: "songA", audio_path: "t/g/a.mp3", audio_name: "a.mp3" };
    const B = { id: "songB", audio_path: null, audio_name: null };
    const set = [
      makeItem(1, { song_id: "songA", audio_path: "t/g/a.mp3", audio_name: "a.mp3", duration_seconds: 200 }),
      makeItem(2, { duration_seconds: 200 }),
      makeItem(3, { duration_seconds: 200 }),
    ];
    const media = instrumentMediaElements();
    supa.setScript({ setlist_items: ok(set), songs: ok([A]), show_authority: ok([]) });
    h.saved = set.map((it) => ({
      itemId: it.id,
      blob: Object.assign(new Blob([it.id]), { row: it.id }),
      name: `${it.id}.wav`,
      path: it.id === "item-1" ? "t/g/a.mp3" : null,
    }));
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Pads"
        items={set}
        songAudio={{ songA: { path: A.audio_path, name: A.audio_name } }}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    await act(async () => {});
    await startShowFromUi();
    await tick(2_000);
    await press(2); // Track 1 (song A) goes under, still sounding
    const [one] = playing(media, "item-1");
    expect(one).toBeTruthy();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    // another device swaps row 1 to song B while song A sounds under NOW
    supa.setScript({
      setlist_items: ok([makeItem(1, { song_id: "songB", title: "Track B", duration_seconds: 200 }), set[1], set[2]]),
      songs: ok([A, B]),
      show_authority: ok([]),
    });
    await act(async () => {
      live().emit("setlist-changed", {});
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});
    await act(async () => {});
    // still sounding as a layer...
    expect(media.state(one).paused).toBe(false);
    expect(media.state(one).src).toBe("blob:item-1");
    // ...so its URL must not be revoked under it (the primary gets the on-air lock)
    expect(revoke).not.toHaveBeenCalledWith("blob:item-1");
  });
});

// ── P5: Auto Mute's adoptTail hands Auto a spare that was never unlocked (WebKit) ───────────────
// WebKit grants play() per ELEMENT (primeSecondaryAudio's own comment). START primes the two
// first elements; firePad / stopNowPad prime the spare they hand out. autoMute → adoptTail →
// freePlayer() may make a BRAND-NEW element the spare and nothing primes it: Auto's next overlap
// then starts the next row on it from a timer - refused on iPhone / iPad: silence + the banner.
describe("LiveMode pads · every new player is unlocked in the tap that makes it", () => {
  it("every element Auto's overlap starts a row on has played inside a tap before", async () => {
    const set = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 30, buffer_before_seconds: -5 }),
      makeItem(3, { duration_seconds: 60, buffer_before_seconds: -5 }),
    ];
    const media = await startPads(set);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(5_250); // Track 2 comes in over Track 1's last 5 s (the tail on the spare)
    expect(last().currentIndex).toBe(1);
    expect(playing(media, "item-1")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mute" })); // during the tail
    });
    // the operator keeps the show going
    const keep = screen.queryByRole("button", { name: "ยังไม่จบ" });
    if (keep) await act(async () => fireEvent.click(keep));
    const callsAtMute = media.calls.length;
    await tick(26_000); // Track 2's 30 s less Track 3's 5 s lead: Auto's overlap starts Track 3
    expect(last().currentIndex).toBe(2);
    const [three] = playing(media, "item-3");
    expect(three).toBeTruthy();
    // had this element ever played before Auto's timer started Track 3 on it?
    const playedBefore = media.calls.slice(0, callsAtMute).some((c) => c.element === three && c.type === "play");
    expect(playedBefore).toBe(true);
  });
});

// ── controls: the same flows without the trigger pass (the probes above are honest) ─────────────
describe("LiveMode pads · the same flows without the trigger", () => {
  it("Auto Mute on NOW lands at 0 when no fader is touched", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    const [three] = playing(media, "item-3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    });
    await tick(4_000);
    expect(media.state(three).volume).toBeLessThan(0.01);
  });


  it("without Auto Mute, Auto's overlap starts on an element that has played before", async () => {
    const set = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { duration_seconds: 30, buffer_before_seconds: -5 }),
      makeItem(3, { duration_seconds: 60, buffer_before_seconds: -5 }),
    ];
    const media = await startPads(set);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await tick(5_250);
    const callsBefore = media.calls.length;
    await tick(26_000);
    expect(last().currentIndex).toBe(2);
    const [three] = playing(media, "item-3");
    expect(media.calls.slice(0, callsBefore).some((c) => c.element === three && c.type === "play")).toBe(true);
  });
});
