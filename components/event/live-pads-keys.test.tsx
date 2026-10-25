// SET MIXER's pads - the keys: Enter at the last row (GO off) clicks nothing that has the focus,
// the N key on a Thai keyboard layout, and GO after a MANUAL cue.
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
const SET = [1, 2, 3, 4].map((n) => makeItem(n));

let supa: SupabaseFake;
const live = (): ChannelFake => {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error("no channel");
  return ch;
};
const stateSends = () => live().sent.filter((s) => s.event === "state");
const last = () => stateSends().at(-1)!.payload;

const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
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
  localStorage.removeItem("cueiq:liveView");
});

async function startPads(): Promise<MediaInstrumentation> {
  const media = instrumentMediaElements();
  h.saved = SET.map((it) => ({ itemId: it.id, blob: Object.assign(new Blob([it.id]), { row: it.id }), name: `${it.id}.wav`, path: null }));
  render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pads" items={SET} songAudio={{}} canEdit lastRunSeconds={null} lastRunAt={null} />
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
/** A mouse click on a pad: Chromium (web + Electron, Windows) leaves the focus on the button. */
const clickPad = async (n: number) => {
  await act(async () => {
    pad(n).focus();
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

/** Enter as Chromium delivers it: to the focused element; if nobody prevented it, a focused button clicks. */
async function enterLikeBrowser(init: KeyboardEventInit = {}) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  if (!ev.defaultPrevented && target instanceof HTMLButtonElement && !target.disabled) {
    await act(async () => {
      target.click();
    });
  }
  return ev.defaultPrevented;
}

describe("LiveMode pads · Enter at the last row clicks nothing", () => {
  it("the last song fired by its pad (focus on it): Enter does not fade it out", async () => {
    const media = await startPads();
    await tick(2_000);
    await clickPad(4); // the last row - its pad keeps the focus
    expect(last().currentIndex).toBe(3);
    expect(screen.getByTestId("console-go")).toBeDisabled();
    await tick(2_000);
    await enterLikeBrowser(); // the operator's GO habit
    // the final song must still be sounding as NOW, untouched
    expect(pad(4)).toHaveAttribute("data-state", "on");
    await tick(3_250);
    expect(playing(media, "item-4")).toHaveLength(1);
  });

  it("focus on pad 2, then Enter through to the end: the Enter after the last GO leaves row 2 alone", async () => {
    const media = await startPads();
    await tick(2_000);
    await clickPad(2); // row 2 by its pad; focus stays on pad 2
    expect(last().currentIndex).toBe(1);
    await tick(1_000);
    await enterLikeBrowser(); // GO 3
    expect(last().currentIndex).toBe(2);
    await tick(1_000);
    await enterLikeBrowser(); // GO 4 - the last row
    expect(last().currentIndex).toBe(3);
    await tick(1_000);
    await enterLikeBrowser(); // one more Enter: GO is disabled ("จบรายการแล้ว")
    // nothing may happen: the final row stays NOW, and row 2 (still sounding under it) is not touched
    expect(last().currentIndex).toBe(3);
    expect(pad(2)).toHaveAttribute("data-state", "on");
    expect(media && playing(media, "item-2").length).toBeLessThanOrEqual(1);
  });

  it("same, row 2 played out by then (grey): the extra Enter does not start it again", async () => {
    const media = await startPads();
    await tick(2_000);
    await clickPad(2);
    expect(last().currentIndex).toBe(1);
    await tick(1_000);
    await enterLikeBrowser(); // GO 3
    await tick(1_000);
    await enterLikeBrowser(); // GO 4 - the last row
    expect(last().currentIndex).toBe(3);
    // row 2's file runs out under the final song
    const [two] = playing(media, "item-2");
    await act(async () => {
      media.set(two, { paused: true, ended: true });
      media.emit(two, "ended");
    });
    expect(pad(2)).toHaveAttribute("data-state", "played");
    await tick(1_000);
    await enterLikeBrowser(); // GO is disabled → the focused grey pad 2 clicks
    expect(last().currentIndex).toBe(3);
    expect(playing(media, "item-2")).toHaveLength(0);
  });

  it("a held Enter on the second-last row: GO once, and the repeats click nothing", async () => {
    await startPads();
    await tick(2_000);
    await clickPad(3); // row 3 by its pad, focus on pad 3; GO = row 4 (the last)
    await tick(1_000);
    await enterLikeBrowser({ repeat: false }); // GO 4
    expect(last().currentIndex).toBe(3);
    for (let i = 0; i < 25; i++) {
      await act(async () => {
        vi.advanceTimersByTime(33);
      });
      await enterLikeBrowser({ repeat: true });
    }
    expect(last().currentIndex).toBe(3);
    expect(pad(3)).not.toHaveAttribute("data-state", "fade");
  });

  it("Enter on the focused RUN at the last row never pauses the show", async () => {
    await startPads();
    await tick(2_000);
    await act(async () => {
      fireEvent.click(screen.getByTestId("console-go")); // GO 2
    });
    await tick(1_000);
    // the operator clicked Pause → Run with the mouse earlier: focus on RUN
    const run = screen.getByTestId("run-toggle");
    await act(async () => {
      run.focus();
    });
    await enterLikeBrowser(); // GO 3
    await tick(1_000);
    await enterLikeBrowser(); // GO 4
    expect(last()).toMatchObject({ currentIndex: 3, running: true });
    await tick(1_000);
    await enterLikeBrowser(); // GO is disabled → RUN clicks
    expect(last()).toMatchObject({ currentIndex: 3, running: true });
  });
});

describe("LiveMode · the N key with the Thai keyboard layout on", () => {
  it("N on a Thai (Kedmanee) layout (e.key 'ื', e.code KeyN) still cues the next row", async () => {
    await startPads();
    await tick(2_000);
    const before = last().currentIndex;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ื", code: "KeyN", bubbles: true, cancelable: true }));
    });
    expect(last().currentIndex).toBe(before + 1);
  });
});

describe("LiveMode pads · MANUAL's cue and GO", () => {
  it("→ cues row 2 (nothing plays): GO names it and fires it", async () => {
    const media = await startPads();
    await tick(2_000);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(last()).toMatchObject({ currentIndex: 1, running: false });
    // what GO says it will fire
    const goText = screen.getByTestId("console-go").textContent ?? "";
    await enterLikeBrowser();
    // the cued row is the one the operator meant to go to
    expect({ goText, now: last().currentIndex, row2: playing(media, "item-2").length }).toEqual({
      goText: expect.stringContaining("Track 2"),
      now: 1,
      row2: 1,
    });
  });
});
