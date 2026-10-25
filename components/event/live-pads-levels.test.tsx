// SET MIXER's pads against the 2026-10-24 level and URL fixes (44c3cbd, 7660130, c16bb8e, 98f7dc7,
// 8f0bc69): a row starts at its own level, a ducked song gets it back, Auto Mute saves no 0, a
// sounding file is never revoked - by every road the pads opened, the encore after Auto Mute too.
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
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(async (path: string) => Object.assign(new Blob([path]), { row: path })),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async () => null),
  cacheSongBlob: vi.fn(async () => {}),
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  getLocalSource: vi.fn(async () => null),
  listLocalSourceIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "@/components/event/live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const TOPIC = liveTopic(EVENT_ID);
const VOL_KEY = `cueiq:vol:${EVENT_ID}`;

function makeItem(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `Track ${n}`,
    duration_seconds: 200,
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
const last = () => stateSends().at(-1)!.payload;

const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
const SET = [
  makeItem(1),
  makeItem(2),
  makeItem(3),
  makeItem(4, { kind: "mc", title: "MC BGM", loop_audio: true, duration_seconds: 120 }),
  makeItem(5),
  makeItem(6),
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
  localStorage.clear();
  vi.useRealTimers();
});

async function startPads(set = SET, rows: string[] = set.map((it) => it.id)) {
  const media = instrumentMediaElements();
  supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
  h.saved = set
    .filter((it) => rows.includes(it.id))
    .map((it) => ({
      itemId: it.id,
      blob: Object.assign(new Blob([it.id]), { row: it.id }),
      name: `${it.id}.wav`,
      path: null,
    }));
  render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Pads"
      items={set}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  await act(async () => {
    live().setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  return media;
}
const pads = () => screen.getAllByTestId("console-pad");
const pad = (n: number) => pads()[n - 1];
const press = async (n: number) => {
  await act(async () => {
    fireEvent.click(pad(n));
  });
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
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
/** the element's volume at the moment play() was called on it last */
function volumeAtPlay(media: MediaInstrumentation, el: HTMLMediaElement): number {
  const calls = media.callsFor(el);
  const playAt = calls.map((c) => c.type).lastIndexOf("play");
  let v = 1;
  for (let i = 0; i < playAt; i++) if (calls[i].type === "volume") v = calls[i].value as number;
  return v;
}
const savedVols = (): Record<string, number> => JSON.parse(localStorage.getItem(VOL_KEY) ?? "{}");

describe("LiveMode pads · levels: the harness", () => {
  it("a pad plays its row, the old row plays on under it", async () => {
    const media = await startPads();
    await tick(2_000);
    await press(3);
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(playing(media, "item-1")).toHaveLength(1);
    expect(last()).toMatchObject({ currentIndex: 2, running: true });
  });
});

// ── 44c3cbd: a row starts at its own level, not the last song's ──────────────────────────────
describe("LiveMode pads · a row starts at its own level (44c3cbd)", () => {
  it("a pad-fired row opens at its own 30 %, not the 100 % of the song it plays over", async () => {
    localStorage.setItem(VOL_KEY, JSON.stringify({ "item-3": 30 }));
    const media = await startPads();
    await tick(2_000);
    await press(3);
    const [three] = playing(media, "item-3");
    expect(volumeAtPlay(media, three)).toBeCloseTo(0.3);
  });

  it("a pooled element a layer faded to 0 on, reused for a row: that row opens at its own level", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(2);
    await tick(1_000);
    await press(1); // layer 1 fades out (3 s) on its element
    await tick(3_250);
    // use every pad so the faded element gets reused
    for (const n of [3, 5, 6]) {
      await tick(1_000);
      await press(n);
    }
    for (const id of ["item-2", "item-3", "item-5", "item-6"]) {
      const [el] = playing(media, id);
      expect(el, id).toBeTruthy();
      expect(volumeAtPlay(media, el), id).toBeCloseTo(1);
    }
  });

  it("GO (Enter) after an MC duck on NOW: the next row opens at its own level, not the duck's 30", async () => {
    const media = await startPads();
    await tick(1_000);
    await click(screen.getByRole("button", { name: "MC" }));
    await tick(2_250);
    await click(screen.getByTestId("console-go"));
    const [two] = playing(media, "item-2");
    expect(volumeAtPlay(media, two)).toBeCloseTo(1);
  });
});

// ── 7660130: a ducked song that runs out on its own gets its own level back ─────────────────────
describe("LiveMode pads · a ducked song gets its own level back (7660130)", () => {
  it("MC on NOW, a pad puts it under, it runs out as a layer: its saved level is its own; its replay opens at it", async () => {
    const media = await startPads();
    const first = media.first()!;
    await tick(1_000);
    await click(screen.getByRole("button", { name: "MC" }));
    await tick(2_250);
    await press(3);
    await tick(1_000);
    // the layer runs out on its own
    await act(async () => {
      media.set(first, { paused: true, ended: true });
      media.emit(first, "ended");
    });
    await tick(1_000);
    expect(savedVols()["item-1"] ?? 100).toBe(100);
    await press(1);
    const [one] = playing(media, "item-1");
    expect(volumeAtPlay(media, one)).toBeCloseTo(1);
  });

  it("MC on a pad-fired NOW that then runs out on its own: its level comes back", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    const [three] = playing(media, "item-3");
    await click(screen.getByRole("button", { name: "MC" }));
    await tick(2_250);
    expect(media.state(three).volume).toBeCloseTo(0.3, 2);
    await act(async () => {
      media.set(three, { paused: true, ended: true });
      media.emit(three, "ended");
    });
    await tick(1_000);
    expect(savedVols()["item-3"] ?? 100).toBe(100);
  });

  it("Auto Mute on NOW, NOW's own pad pressed during the fade: its saved level stays its own", async () => {
    await startPads();
    await tick(1_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(1_000);
    await press(1); // NOW's own green pad (past its first half second)
    await tick(4_000);
    expect(savedVols()["item-1"] ?? 100).toBe(100);
  });
});

// ── c16bb8e: Auto Mute with nothing sounding saves no 0; a reset stops a key's fade ──────────────
describe("LiveMode pads · Auto Mute saves no 0 (c16bb8e)", () => {
  it("only layers sound (NOW ran out on its own): Auto Mute fades them and saves no 0 anywhere", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    const [three] = playing(media, "item-3");
    await tick(1_000);
    await act(async () => {
      media.set(three, { paused: true, ended: true });
      media.emit(three, "ended");
    });
    await tick(500);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(4_000);
    const v = savedVols();
    for (const id of SET.map((x) => x.id)) {
      if (id in v) expect(v[id], id).toBeGreaterThan(0);
    }
    expect(playing(media, "item-1")).toEqual([]);
  });

  it("only layers sound (NOW is a row with no file): Auto Mute saves no 0", async () => {
    const media = await startPads(SET, ["item-1", "item-2", "item-3", "item-5", "item-6"]); // the MC BGM row has no file
    await tick(1_000);
    await press(4);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(4_000);
    const v = savedVols();
    for (const id of SET.map((x) => x.id)) {
      if (id in v) expect(v[id], id).toBeGreaterThan(0);
    }
    expect(playing(media, "item-1")).toEqual([]);
  });

  it("Auto Mute with layers, then a reset before its fade lands: every level stays its own", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await startPads();
    await tick(1_000);
    await press(3);
    await tick(1_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(1_000);
    await click(screen.getByTestId("reset"));
    await tick(4_000);
    const v = savedVols();
    for (const id of SET.map((x) => x.id)) {
      if (id in v) expect(v[id], id).toBeGreaterThan(0);
    }
    confirm.mockRestore();
  });

  it("Auto Mute on NOW, a pad during its fade, then a reset: no 0 saved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await startPads();
    await tick(1_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(1_000);
    await press(3);
    await tick(250);
    await click(screen.getByTestId("reset"));
    await tick(4_000);
    const v = savedVols();
    for (const id of SET.map((x) => x.id)) {
      if (id in v) expect(v[id], id).toBeGreaterThan(0);
    }
    confirm.mockRestore();
  });
});

// ── the single-slot fade: a layer's tile fader vs. NOW's key fade ─────────────────────────────────
describe("LiveMode pads · NOW's key fade vs. a layer's tile fader", () => {
  it("Auto Mute on NOW while a layer sounds; the layer's fader is touched mid-fade: NOW still goes all the way down", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3); // NOW = 3, layer = 1
    const [three] = playing(media, "item-3");
    await tick(1_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(1_000);
    const fader = screen.getAllByTestId("console-tile-fader")[0]; // row 1's tile (the layer)
    await act(async () => {
      fireEvent.keyDown(fader, { key: "ArrowDown" });
    });
    await tick(3_000);
    expect(media.state(three).volume).toBeLessThan(0.01);
  });

  it("MC on NOW while the operator rides a layer's fader: NOW reaches the MC's 30", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3); // NOW = 3, layer = 1
    const [three] = playing(media, "item-3");
    await tick(1_000);
    await click(screen.getByRole("button", { name: "MC" }));
    await tick(500);
    const fader = screen.getAllByTestId("console-tile-fader")[0];
    await act(async () => {
      fireEvent.keyDown(fader, { key: "ArrowDown" });
    });
    await tick(3_000);
    expect(media.state(three).volume).toBeCloseTo(0.3, 2);
  });
});

// ── URLs: the on-air lock (a sounding track's file is never re-downloaded / revoked) vs. a layer ──
describe("LiveMode pads · a layer's URL is never revoked under it", () => {
  it("NOW's master re-uploaded mid-song (deferred by the on-air lock), then a pad puts it under: its URL is not revoked while it still sounds", async () => {
    const V1 = SET.map((it) => (it.id === "item-1" ? { ...it, audio_path: "g/item-1-v1" } : it));
    const V2 = SET.map((it) => (it.id === "item-1" ? { ...it, audio_path: "g/item-1-v2" } : it));
    const media = instrumentMediaElements();
    supa.setScript({ setlist_items: ok(V1), songs: ok([]), show_authority: ok([]) });
    h.saved = SET.map((it) => ({
      itemId: it.id,
      blob: Object.assign(new Blob([it.id]), { row: it.id }),
      name: `${it.id}.wav`,
      path: it.id === "item-1" ? "g/item-1-v1" : null,
    }));
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pads" items={V1} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await act(async () => {});
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    const first = media.first()!;
    expect(playing(media, "item-1")).toEqual([first]);
    await tick(5_000);
    // another device re-uploads Track 1's master while it plays: the lock defers it
    supa.setScript({ setlist_items: ok(V2), songs: ok([]), show_authority: ok([]) });
    await act(async () => {
      live().emit("setlist-changed", { sender: "other-device" });
    });
    await tick(1_000);
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:item-1"); // the lock held
    // a pad: Track 1 goes UNDER and plays on to its own end
    await press(3);
    await tick(1_000);
    await act(async () => {});
    expect(playing(media, "item-1")).toEqual([first]);
    // …and the file it is playing must not be pulled out from under it
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:item-1");
  });
});

describe("LiveMode pads · more level and URL paths", () => {
  it("Auto Mute on a pad-fired NOW (pooled element) that runs out during the fade: its level comes back", async () => {
    const media = await startPads();
    await tick(1_000);
    await press(3);
    const [three] = playing(media, "item-3");
    await tick(1_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(1_000);
    await act(async () => {
      media.set(three, { paused: true, ended: true });
      media.emit(three, "ended");
    });
    await tick(4_000);
    expect(savedVols()["item-3"] ?? 100).toBe(100);
    await press(3);
    const [again] = playing(media, "item-3");
    expect(volumeAtPlay(media, again)).toBeCloseTo(1);
  });

  it("a row ALREADY sounding as a layer gets a new master from the library: the URL it plays is not revoked under it", async () => {
    const V1 = SET.map((it) => (it.id === "item-1" ? { ...it, audio_path: "g/item-1-v1" } : it));
    const V2 = SET.map((it) => (it.id === "item-1" ? { ...it, audio_path: "g/item-1-v2" } : it));
    const media = instrumentMediaElements();
    supa.setScript({ setlist_items: ok(V1), songs: ok([]), show_authority: ok([]) });
    h.saved = SET.map((it) => ({
      itemId: it.id,
      blob: Object.assign(new Blob([it.id]), { row: it.id }),
      name: `${it.id}.wav`,
      path: it.id === "item-1" ? "g/item-1-v1" : null,
    }));
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pads" items={V1} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await act(async () => {});
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    const first = media.first()!;
    await tick(2_000);
    await press(3); // Track 1 goes under
    await tick(1_000);
    supa.setScript({ setlist_items: ok(V2), songs: ok([]), show_authority: ok([]) });
    await act(async () => {
      live().emit("setlist-changed", { sender: "other-device" });
    });
    await tick(1_000);
    await act(async () => {});
    expect(playing(media, "item-1")).toEqual([first]);
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:item-1");
  });
});

// ── 7660130's "a replay of a ducked song starts at the duck (after Auto Mute: silent)", by the pad ──
describe("LiveMode pads · a pad replays a ducked row from its top at its own level", () => {
  it("Auto Mute → จบโชว์ → encore: the same song's pad plays it from the top at its own level, not Auto Mute's 0", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(3_500);
    await click(screen.getByTestId("end-show"));
    await tick(1_000);
    expect(playing(media, "item-1")).toEqual([]);
    await press(1); // encore: the same song from its top
    const [one] = playing(media, "item-1");
    expect(one).toBeTruthy();
    expect(media.state(one).currentTime).toBe(0);
    expect(volumeAtPlay(media, one)).toBeCloseTo(1);
  });

  it("Auto Mute → Pause → the same song's pad: from the top at its own level", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(3_500);
    await click(screen.getByTestId("run-toggle")); // pause
    await press(1);
    const [one] = playing(media, "item-1");
    expect(one).toBeTruthy();
    expect(volumeAtPlay(media, one)).toBeCloseTo(1);
  });

  it("MC → Pause → the same song's pad: from the top at its own level, not the MC's 30", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "MC" }));
    await tick(2_500);
    await click(screen.getByTestId("run-toggle")); // pause
    await press(1);
    const [one] = playing(media, "item-1");
    expect(one).toBeTruthy();
    expect(volumeAtPlay(media, one)).toBeCloseTo(1);
  });

  it("(control) Auto Mute → จบโชว์ → the pad of ANOTHER row: its own level", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(3_500);
    await click(screen.getByTestId("end-show"));
    await press(2);
    const [two] = playing(media, "item-2");
    expect(volumeAtPlay(media, two)).toBeCloseTo(1);
  });
});

describe("LiveMode pads · the encore after Auto Mute is heard", () => {
  it("Auto Mute → จบโชว์ → the same song's pad: heard for the whole song", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(3_500);
    await click(screen.getByTestId("end-show"));
    await press(1);
    await tick(20_000);
    const [one] = playing(media, "item-1");
    expect(pad(1)).toHaveAttribute("data-state", "on");
    expect(last()).toMatchObject({ currentIndex: 0, running: true });
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeNull();
    expect(media.state(one).paused).toBe(false);
    expect(media.state(one).volume).toBeGreaterThan(0.5);
  });

});

describe("LiveMode pads · the encore, through the จบการแสดงเลยไหม bar", () => {
  it("Auto Mute → 'จบโชว์ · บันทึกเวลา' on its bar → encore on the same song's pad: it must be heard", async () => {
    const media = await startPads();
    await tick(10_000);
    await click(screen.getByRole("button", { name: "Mute" }));
    await tick(3_500);
    await click(screen.getByRole("button", { name: /จบโชว์ · บันทึกเวลา/ }));
    await tick(30_000); // the crowd calls for it
    await press(1);
    await tick(5_000);
    const [one] = playing(media, "item-1");
    expect(one).toBeTruthy();
    expect(media.state(one).volume).toBeGreaterThan(0.5);
  });
});
