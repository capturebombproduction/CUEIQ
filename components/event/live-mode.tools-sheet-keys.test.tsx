// 2026-10-30, hunt 12 (keys-1, keys-3, keys-4, fresh-1): the operator's keys around Live tools.
//
// The sheet's own key guard sees only keys aimed inside it, and a key in it can take the focus away
// with it: ล้าง swaps for its question, รีเซ็ต goes, จบโชว์ turns disabled, and Chromium hands the focus to
// <body> (measured on Electron 45) with the sheet still open. The next key reached the window: Enter, the
// natural yes to ล้าง's question, fired GO behind the modal; Space paused the show, or STARTed it after a
// reset; Esc did nothing. Also here: a double-click on ล้าง landed on ล้างเลย, Space on a question's button
// paused the show, and Home on a slider took the level to 0 in one key.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { makeSupabaseFake, instrumentMediaElements, makeSession, ok, type SupabaseFake, type ChannelFake } from "@/test/fakes/supabase";
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
const makeItem = (n: number): SetlistItem => ({
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
});
const SET = [1, 2, 3, 4].map(makeItem);
let supa: SupabaseFake;
const live = (): ChannelFake => supa.channelFor(TOPIC)!;
const last = () => live().sent.filter((s) => s.event === "state").at(-1)!.payload;
const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  supa = makeSupabaseFake({ session: makeSession(), script: { setlist_items: ok(SET), songs: ok([]), show_authority: ok([]) } });
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

const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};
async function startPads() {
  instrumentMediaElements();
  h.saved = SET.map((it) => ({ itemId: it.id, blob: Object.assign(new Blob([it.id]), { row: it.id }), name: `${it.id}.wav`, path: null }));
  render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pads" items={SET} songAudio={{}} canEdit lastRunSeconds={754} lastRunAt="2026-08-07T11:00:00Z" />
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
  await tick(2_000);
}
const sheet = () => screen.getByRole("dialog", { name: "Live tools", hidden: true });
const sheetShut = () => (sheet().parentElement as HTMLElement).hidden;
async function openTools() {
  const btn = screen.getByRole("button", { name: "Live tools" });
  await act(async () => {
    btn.focus();
    fireEvent.click(btn);
  });
}
/** A mouse click: Chromium leaves the focus on the button; a key that unmounts drops it to body. */
async function mouseClick(el: HTMLElement) {
  await act(async () => {
    el.focus();
    fireEvent.click(el);
  });
}
/** A key as Chromium delivers it: to the focused element. Returns the event. */
async function press(key: string, code = key) {
  const target = (document.activeElement as HTMLElement) ?? document.body;
  const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  return ev;
}
const inSheet = (name: string) => within(sheet()).getByRole("button", { name, hidden: true });
const dropFocus = async () => {
  await act(async () => {
    (document.activeElement as HTMLElement).blur();
  });
  expect(document.activeElement).toBe(document.body);
};

describe("Live tools: a key that takes the focus with it leaves the show's keys asleep", () => {
  it("Enter with the focus fallen out of the open sheet does not fire GO behind it", async () => {
    await startPads();
    await openTools();
    await dropFocus();
    const before = last().currentIndex;
    await press("Enter");
    expect(last().currentIndex).toBe(before);
    expect(document.activeElement).toBe(sheet());
  });

  it("Space with the focus fallen out of the open sheet does not pause the show behind it", async () => {
    await startPads();
    await openTools();
    await dropFocus();
    await press(" ", "Space");
    expect(last().running).toBe(true);
  });

  it("N and → with the focus fallen out do not walk the setlist", async () => {
    await startPads();
    await openTools();
    await dropFocus();
    const before = last().currentIndex;
    await press("ArrowRight");
    await dropFocus();
    await press("n", "KeyN");
    expect(last().currentIndex).toBe(before);
  });

  it("Esc with the focus fallen out still closes the sheet, and the focus goes back to ⋯", async () => {
    await startPads();
    await openTools();
    await dropFocus();
    await press("Escape");
    expect(sheetShut()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Live tools" }));
  });

  it("after รีเซ็ต in the sheet (its key gone, the sheet still open) Space does not START the show", async () => {
    await startPads();
    await openTools();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mouseClick(within(sheet()).getByTestId("reset"));
    expect(last().begun).toBe(false);
    expect(document.activeElement).toBe(document.body);
    await tick(2_000);
    await press(" ", "Space");
    await tick(2_000);
    expect(last().begun).toBe(false);
  });

  it("with the sheet shut the show's keys are the show's again", async () => {
    await startPads();
    await openTools();
    await press("Escape");
    expect(sheetShut()).toBe(true);
    await press(" ", "Space");
    expect(last().running).toBe(false);
  });

  it("a key aimed inside the sheet stays the sheet's: Enter on its focused button is not taken", async () => {
    await startPads();
    await openTools();
    const close = inSheet("ปิด");
    expect(document.activeElement).toBe(close);
    const ev = await press("Enter");
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(close); // not moved to the panel
    expect(last().currentIndex).toBe(0);
  });

  it("a key aimed inside a portalled dialog is not taken, and Esc with one open leaves the sheet open", async () => {
    await startPads();
    await openTools();
    const portal = document.createElement("div");
    portal.setAttribute("role", "dialog");
    portal.setAttribute("data-state", "open");
    const input = document.createElement("textarea");
    portal.appendChild(input);
    document.body.appendChild(portal);
    try {
      let seen = 0;
      const listener = () => {
        seen++;
      };
      portal.addEventListener("keydown", listener);
      input.focus();
      await press("a", "KeyA");
      expect(seen).toBe(1);
      expect(document.activeElement).toBe(input);
      await act(async () => {
        input.blur();
      });
      await press("Escape");
      expect(sheetShut()).toBe(false);
      // the focus trap's to take back: the guard does not pull it into the sheet
      await press("Enter");
      expect(document.activeElement).toBe(document.body);
      expect(last().currentIndex).toBe(0);
    } finally {
      portal.remove();
    }
  });
});

describe("ล้าง's question: the focus and the double-click", () => {
  const clear = () => inSheet("ล้าง");

  it("the question opens with the focus on ไม่ล้าง, so the next Enter never leaves the sheet", async () => {
    await startPads();
    await openTools();
    await mouseClick(clear());
    expect(document.activeElement).toBe(inSheet("ไม่ล้าง"));
  });

  it("ไม่ล้าง gives the focus back to ล้าง", async () => {
    await startPads();
    await openTools();
    await mouseClick(clear());
    await mouseClick(inSheet("ไม่ล้าง"));
    expect(document.activeElement).toBe(clear());
  });

  it("the key that takes ล้าง's place at the row's right end is the safe one", async () => {
    await startPads();
    await openTools();
    const key = clear();
    const row = key.parentElement as HTMLElement;
    expect(row.lastElementChild).toBe(key);
    await mouseClick(key);
    const buttons = row.querySelectorAll("button");
    expect(buttons[buttons.length - 1].textContent).toBe("ไม่ล้าง");
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(["ล้างเลย", "ไม่ล้าง"]);
  });

  it("a double-click on ล้าง keeps the record", async () => {
    await startPads();
    await openTools();
    const key = clear();
    const row = key.parentElement as HTMLElement;
    await mouseClick(key);
    const buttons = row.querySelectorAll("button");
    await mouseClick(buttons[buttons.length - 1] as HTMLElement); // the second click, same place
    expect(within(sheet()).getAllByText(/12:34/).length).toBeGreaterThan(0);
    expect(live().sent.filter((s) => s.event === "lastrun")).toHaveLength(0);
  });
});

describe("Space on a question's button is that button", () => {
  it("Space on a key inside a role=dialog bar on the Live screen is left to the key", async () => {
    await startPads();
    const bar = document.createElement("div");
    bar.setAttribute("role", "dialog");
    const key = document.createElement("button");
    bar.appendChild(key);
    document.body.appendChild(bar);
    try {
      key.focus();
      const ev = await press(" ", "Space");
      expect(ev.defaultPrevented).toBe(false); // Chromium's click comes on its keyup
      expect(last().running).toBe(true);
    } finally {
      bar.remove();
    }
  });
});

describe("A slider in the operator's focus: no one key to a far level", () => {
  // Chromium: Home = 0, End = full, a page = 10% (measured on Electron 45); jsdom has no such
  // default, so what is proved is that the default is taken away.
  it.each(["Home", "End", "PageUp", "PageDown"])("%s on a level slider inside the sheet does nothing", async (key) => {
    await startPads();
    await openTools();
    const slider = within(sheet()).getAllByRole("slider", { hidden: true })[0];
    await act(async () => {
      slider.focus();
    });
    expect((await press(key)).defaultPrevented).toBe(true);
  });

  it.each(["Home", "End", "PageUp", "PageDown"])("%s on a slider outside the sheet does nothing", async (key) => {
    await startPads();
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.appendChild(slider);
    try {
      slider.focus();
      expect((await press(key)).defaultPrevented).toBe(true);
    } finally {
      slider.remove();
    }
  });

  it("↑ still moves it: the key is left alone", async () => {
    await startPads();
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.appendChild(slider);
    try {
      slider.focus();
      expect((await press("ArrowUp")).defaultPrevented).toBe(false);
    } finally {
      slider.remove();
    }
  });
});
