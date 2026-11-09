// SET MIXER's pads BEFORE START (พี่ 2026-11-10: "ตอนนี้โหมดแมนนวล ถ้าไม่กดรันเพลงแรก มันกดคอนโซล
// mixer แยกอิสระไม่ได้ อยากให้กดเล่นได้เลยตามแบบแมนนวลที่ควรเป็น"). In MANUAL the first pad pressed - or
// GO / Enter - begins the show on its OWN row, by START's road (the sync gate, the authority
// probe, one start at a time). In AUTO, and before the first sync, the pads wait as before.
// Harness as components/event/live-pads-state.test.tsx.
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
  warned: [] as string[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("sonner", async (orig) => {
  const real = await orig<typeof import("sonner")>();
  const toast = Object.assign((...a: unknown[]) => (real.toast as unknown as (...x: unknown[]) => unknown)(...a), real.toast, {
    warning: (msg: unknown) => {
      h.warned.push(String(msg));
      return 0;
    },
  });
  return { ...real, toast };
});

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

const SET = [1, 2, 3, 4, 5].map((n) => makeItem(n));
const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
let supa: SupabaseFake;

function live(): ChannelFake {
  const ch = supa.channels.filter((c) => c.name === TOPIC).at(-1) ?? supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
const stateSends = () => live().sent.filter((s) => s.event === "state");
const last = () => stateSends().at(-1)?.payload;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  h.warned = [];
  localStorage.clear();
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
  vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page open on CONSOLE, files on the device, NOT started. `settle`: its first sync is in. */
async function openPads(
  { set = SET, withFile = () => true, settle = true }: { set?: SetlistItem[]; withFile?: (it: SetlistItem) => boolean; settle?: boolean } = {}
): Promise<MediaInstrumentation> {
  const media = instrumentMediaElements();
  supa.setScript({ setlist_items: ok(set), songs: ok([]), show_authority: ok([]) });
  h.saved = set.filter(withFile).map((it) => ({
    itemId: it.id,
    blob: Object.assign(new Blob([it.id]), { row: it.id }),
    name: `${it.id}.wav`,
    path: null,
  }));
  render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pads" items={set} songAudio={{}} canEdit lastRunSeconds={null} lastRunAt={null} />
  );
  await act(async () => {});
  if (settle) {
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
  }
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
function pressKey(target: EventTarget, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

describe("LiveMode pads · before START (MANUAL)", () => {
  it("the pads are live, and the first one pressed begins the show on its own row - not on row 1", async () => {
    const media = await openPads();
    expect(screen.getByTestId("start-show")).toBeInTheDocument();
    for (const p of pads()) expect(p).toBeEnabled();
    expect(screen.getByTestId("console-pads-head").textContent).toContain("MANUAL");
    await press(3);
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 2, currentItemId: "item-3", mode: "manual" });
    expect(last()!.startedAt).toBe(last()!.itemStartedAt);
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(playing(media, "item-1")).toEqual([]);
    expect(pad(3)).toHaveAttribute("data-state", "on");
    expect(pad(1)).toHaveAttribute("data-state", "ready");
    // the show is on: START gave way to NEXT, as after START itself
    expect(screen.queryByTestId("start-show")).toBeNull();
    expect(screen.getByTestId("next")).toBeInTheDocument();
  });

  it("a double-click on that pad leaves it sounding (the second click is not 'fade it out')", async () => {
    const media = await openPads();
    await press(3);
    await press(3);
    await tick(250);
    await press(3); // still inside its first half second
    expect(pad(3)).toHaveAttribute("data-state", "on");
    await tick(3_500);
    expect(playing(media, "item-3")).toHaveLength(1);
  });

  it("from there the pads are the pads: the next one plays over it, GO names the row after", async () => {
    const media = await openPads();
    await press(4);
    await tick(1_000);
    expect(screen.getByTestId("console-go").textContent).toContain("Track 5");
    await press(2);
    expect(last()).toMatchObject({ currentIndex: 1, running: true });
    expect(playing(media, "item-2")).toHaveLength(1);
    expect(playing(media, "item-4")).toHaveLength(1); // plays on under it
    expect(last()!.pads.layers.map((l: { id: string }) => l.id)).toEqual(["item-4"]);
  });

  it("GO and Enter begin on the first row", async () => {
    const media = await openPads();
    expect(screen.getByTestId("console-go").textContent).toContain("Track 1");
    const ev = pressKey(window, { key: "Enter", code: "Enter" });
    await act(async () => {});
    expect(ev.defaultPrevented).toBe(true);
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 0 });
    expect(playing(media, "item-1")).toHaveLength(1);
    // the second Enter of a double press is the same intention: it does not fire row 2
    pressKey(window, { key: "Enter", code: "Enter" });
    await act(async () => {});
    expect(last()).toMatchObject({ currentIndex: 0 });
    expect(playing(media, "item-2")).toEqual([]);
  });

  it("a row with no file (an MC talk): the show begins on it, nothing sounds, and the wire does not call it sounding", async () => {
    const set = [makeItem(1), makeItem(2, { kind: "mc", title: "MC talk", duration_seconds: 60 }), makeItem(3)];
    const media = await openPads({ set, withFile: (it) => it.id !== "item-2" });
    await press(2);
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 1 });
    expect(media.elements.filter((el) => !media.state(el).paused && media.state(el).src.startsWith("blob:"))).toEqual([]);
    expect(pad(2)).toHaveAttribute("data-state", "ready");
    const p = last()!;
    const viewerLit = p.audioPlaying === true && p.audioItemId === "item-2" && p.pads?.ended !== "item-2";
    expect(viewerLit).toBe(false);
  });

  it("START SHOW itself still begins on row 1", async () => {
    const media = await openPads();
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 0 });
    expect(playing(media, "item-1")).toHaveLength(1);
  });

  // The venue's own failure: on the Wi-Fi with no route out, START's check never answers and its
  // 1.5 s bound decides. For that long the pressed pad says so - a pad that looks dead gets pressed again.
  it("a dead link: the pad says it is starting, a second pad meanwhile starts nothing, and the show begins on the first at 1.5 s", async () => {
    const media = await openPads();
    supa.setTable("show_authority", () => new Promise(() => {}));
    await press(3);
    expect(pad(3)).toHaveAttribute("data-starting", "1");
    expect(pad(3).textContent).toContain("กำลังเริ่ม");
    expect(stateSends().filter((s) => s.payload.begun)).toEqual([]);
    expect(playing(media, "item-3")).toEqual([]);
    await tick(500);
    await press(5); // impatient: START takes one at a time, and this is not queued behind it
    await tick(1_250);
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 2 });
    expect(playing(media, "item-3")).toHaveLength(1);
    expect(playing(media, "item-5")).toEqual([]);
    expect(pad(3)).not.toHaveAttribute("data-starting");
    expect(pad(3)).toHaveAttribute("data-state", "on");
  });

  it("reset, then a pad: a new show begins on that pad's row", async () => {
    const media = await openPads();
    await press(3);
    await tick(1_000);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    expect(playing(media, "item-3")).toEqual([]);
    expect(screen.getByTestId("start-show")).toBeInTheDocument();
    await tick(1_000);
    await press(5);
    expect(last()).toMatchObject({ begun: true, running: true, currentIndex: 4 });
    expect(playing(media, "item-5")).toHaveLength(1);
    expect(playing(media, "item-3")).toEqual([]);
  });
});

describe("LiveMode pads · before START, where a pad begins nothing", () => {
  it("another device holds the show: the pad is refused as START is - nothing plays, nothing is sent", async () => {
    const media = await openPads();
    const now = new Date().toISOString();
    supa.setTable(
      "show_authority",
      ok([
        {
          event_id: EVENT_ID,
          kind: "show_main",
          device_id: "the-pa",
          device_label: "MacBook PA",
          by_user_id: null,
          by_role: null,
          claimed_at: now,
          heartbeat_at: now,
        },
      ])
    );
    await press(3);
    await tick(250);
    expect(stateSends().filter((s) => s.payload.begun)).toEqual([]);
    expect(media.elements.filter((el) => !media.state(el).paused && media.state(el).src.startsWith("blob:"))).toEqual([]);
    expect(h.warned.join(" ")).toContain("MacBook PA");
    expect(screen.getByTestId("start-show")).toBeInTheDocument();
  });

  it("AUTO: the pads wait for START (Auto runs the list from its top)", async () => {
    const media = await openPads();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    for (const p of pads()) expect(p).toBeDisabled();
    expect(screen.queryByTestId("console-go")).toBeNull();
    expect(screen.getByTestId("console-go-locked").textContent).toContain("ยังไม่เริ่มโชว์");
    // Enter is not GO here: left to the browser (a focused START SHOW still starts by Enter)
    const ev = pressKey(window, { key: "Enter", code: "Enter" });
    expect(ev.defaultPrevented).toBe(false);
    expect(stateSends().filter((s) => s.payload.begun)).toEqual([]);
    expect(media.elements.filter((el) => !media.state(el).paused && media.state(el).src.startsWith("blob:"))).toEqual([]);
  });

  it("before this device's first sync is in, the pads wait - as START does", async () => {
    await openPads({ settle: false });
    expect(screen.getByTestId("start-show")).toBeDisabled();
    for (const p of pads()) expect(p).toBeDisabled();
    expect(screen.getByTestId("console-go-locked")).toBeInTheDocument();
  });
});
