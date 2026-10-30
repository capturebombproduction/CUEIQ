// ---------------------------------------------------------------------------
// TWO TABS OF ONE BROWSER, ONE SNAPSHOT KEY, ONE DEVICE ID (2026-10-30, hunt 12).
//
// What used to go wrong:
//  - a tab left on an ended or held run re-wrote cueiq:live:<event> every 30 s: over the
//    snapshot of the show running in another tab (its crash came back as the rehearsal), and
//    back after รีเซ็ต in another tab, so the reset did not stick;
//  - an idle tab that never heard the run cleared that key on every hide;
//  - a copy of the run giving way deleted show_main - the running tab's row, same device id;
//  - a sign-out in another tab asked nothing, because nothing said a show was running.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import { liveShowBeaconIsFresh } from "@/lib/live-guard";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
  deleteAudio: vi.fn(async () => {}),
}));
import { LiveMode } from "@/components/event/live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const KEY = `cueiq:live:${EVENT_ID}`;
const BEACON = "cueiq:live-sounding-at";
const AFTERNOON = 1000;
const TONIGHT = 2000;

const item = (n: number): SetlistItem =>
  ({
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `T${n}`,
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
  }) as SetlistItem;

const snap = (run: number, over: object = {}) =>
  JSON.stringify({
    state: {
      running: true,
      begun: true,
      startedAt: run,
      itemStartedAt: Date.now(),
      itemElapsedAtPause: null,
      currentIndex: 0,
      mode: "manual",
    },
    committed: { id: null, anchor: null },
    isController: true,
    controllerSince: run,
    savedAt: Date.now(),
    ...over,
  });
const ENDED = { ended: true, held: true };
const onDisk = () => {
  const raw = localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
};

let supa: SupabaseFake;
const live = () => supa.channelFor(liveTopic(EVENT_ID))!;

async function mount() {
  const view = render(
    <LiveMode
      eventId={EVENT_ID}
      groupId="g"
      eventName="P"
      items={[item(1)]}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  await tick(1000);
  return view;
}
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}
function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-31T17:00:00+07:00"));
  localStorage.clear();
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok([item(1)]), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the crash-recovery snapshot, shared by this browser's tabs", () => {
  it("a tab on an ended run does not write over the show another tab is running", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON, ENDED));
    await mount();
    localStorage.setItem(KEY, snap(TONIGHT));
    await tick(31_000);
    hide();
    expect(onDisk().controllerSince).toBe(TONIGHT);
  });

  it("nor a tab held with a show nobody has played", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON, { held: true }));
    await mount();
    localStorage.setItem(KEY, snap(TONIGHT));
    await tick(31_000);
    expect(onDisk().controllerSince).toBe(TONIGHT);
  });

  it("a reset in the other tab stays: the tab on the ended run does not put the snapshot back", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON, ENDED));
    await mount();
    localStorage.removeItem(KEY);
    await tick(31_000);
    hide();
    expect(onDisk()).toBeNull();
  });

  it("the ended tab's own copy of its own run is still kept fresh", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON, ENDED));
    await mount();
    const before = onDisk().savedAt;
    await tick(31_000);
    expect(onDisk().controllerSince).toBe(AFTERNOON);
    expect(onDisk().savedAt).toBeGreaterThan(before);
  });

  it("a running page's own write always goes through, whatever is on disk", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    localStorage.setItem(KEY, snap(AFTERNOON, ENDED));
    await tick(31_000);
    expect(onDisk().controllerSince).toBe(TONIGHT);
  });

  it("an idle page does not clear a run it never had (it did not hear it: no realtime)", async () => {
    await mount();
    localStorage.setItem(KEY, snap(TONIGHT));
    hide();
    await tick(1000);
    expect(onDisk()?.controllerSince).toBe(TONIGHT);
  });

  it("an idle page still clears a snapshot past the restore's age limit", async () => {
    await mount();
    localStorage.setItem(KEY, snap(TONIGHT, { savedAt: Date.now() - 7 * 60 * 60 * 1000 }));
    hide();
    expect(onDisk()).toBeNull();
  });

  it("this page's own reset clears its run", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByTestId("reset"));
    vi.unstubAllGlobals();
    await tick(1000);
    expect(onDisk()).toBeNull();
  });

  it("this page's reset leaves another tab's run alone", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON));
    await mount();
    localStorage.setItem(KEY, snap(TONIGHT));
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByTestId("reset"));
    vi.unstubAllGlobals();
    await tick(1000);
    expect(onDisk()?.controllerSince).toBe(TONIGHT);
  });

  it("a storage read that fails behaves as before: the running page still tries its write", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    const real = Storage.prototype.getItem;
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (k === KEY) throw new Error("denied");
      return real.call(this, k);
    });
    const set = vi.spyOn(Storage.prototype, "setItem");
    await tick(31_000);
    const wrote = set.mock.calls.some(([k]) => k === KEY);
    get.mockRestore();
    set.mockRestore();
    expect(wrote).toBe(true);
  });
});

describe("show_main when a copy of the run gives way", () => {
  const released = () => supa.callsTo("show_authority", "delete");
  const stateFrom = (run: number, over: object = {}) => ({
    sender: "other-tab",
    fromController: true,
    begun: true,
    running: true,
    startedAt: run,
    itemStartedAt: Date.now(),
    currentIndex: 0,
    mode: "manual",
    controllerSince: run,
    run,
    sentAt: Date.now(),
    openedAt: Date.now() - 60_000, // that tab opened first: this one is the copy
    ...over,
  });
  async function hearFromOtherTab(payload: object) {
    await act(async () => {
      live().emit("state", payload);
    });
    await tick(100);
  }

  it("the same run: the copy steps down and the row (the first tab's too) is not deleted", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    expect(supa.callsTo("show_authority", "upsert").length).toBeGreaterThan(0);
    await hearFromOtherTab(stateFrom(TONIGHT));
    expect((screen.getByTestId("reset") as HTMLButtonElement).disabled).toBe(true); // it gave way: it watches now
    expect(released()).toHaveLength(0);
  });

  it("a different run does not move a page: no yield, no delete, as before", async () => {
    localStorage.setItem(KEY, snap(AFTERNOON));
    await mount();
    await hearFromOtherTab(stateFrom(TONIGHT));
    expect((screen.getByTestId("reset") as HTMLButtonElement).disabled).toBe(false);
    expect(released()).toHaveLength(0);
  });

  it("after a copy gave way, a later real letting-go of MAIN still releases", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    const view = await mount();
    await hearFromOtherTab(stateFrom(TONIGHT));
    // freed by the reset of the run it watched, then this page runs its own show
    await hearFromOtherTab(stateFrom(TONIGHT, { begun: false, startedAt: null, resetRun: TONIGHT }));
    await tick(2100);
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    await tick(100);
    expect((screen.getByTestId("reset") as HTMLButtonElement).disabled).toBe(false); // it runs its own show now
    expect(released()).toHaveLength(0);
    view.unmount();
    await act(async () => {});
    expect(released()).toHaveLength(1);
  });

  it("an idle page taking up a show has no claim to give back: nothing is deleted", async () => {
    await mount();
    await hearFromOtherTab(stateFrom(TONIGHT));
    expect(released()).toHaveLength(0);
  });
});

describe("the beacon the sign-out in another tab reads", () => {
  it("is stamped while this page runs the show, refreshed inside its age, cleared on unmount", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    const view = await mount();
    expect(liveShowBeaconIsFresh()).toBe(true);
    await tick(55_000);
    await tick(55_000);
    expect(liveShowBeaconIsFresh()).toBe(true);
    view.unmount();
    expect(localStorage.getItem(BEACON)).toBeNull();
  });

  it("no show here, or one over or held: no beacon", async () => {
    await mount();
    expect(localStorage.getItem(BEACON)).toBeNull();
    cleanup();
    localStorage.setItem(KEY, snap(AFTERNOON, ENDED));
    await mount();
    expect(localStorage.getItem(BEACON)).toBeNull();
    cleanup();
    localStorage.setItem(KEY, snap(AFTERNOON, { held: true }));
    await mount();
    expect(localStorage.getItem(BEACON)).toBeNull();
  });

  it("a page that gives way to the tab keeping the run lets it go", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    expect(localStorage.getItem(BEACON)).not.toBeNull();
    await act(async () => {
      live().emit("state", {
        sender: "first-tab",
        fromController: true,
        begun: true,
        running: true,
        startedAt: TONIGHT,
        itemStartedAt: Date.now(),
        currentIndex: 0,
        mode: "manual",
        controllerSince: TONIGHT,
        run: TONIGHT,
        sentAt: Date.now(),
        openedAt: Date.now() - 60_000,
      });
    });
    await tick(100);
    expect(localStorage.getItem(BEACON)).toBeNull();
  });

  it("a reset lets it go", async () => {
    localStorage.setItem(KEY, snap(TONIGHT));
    await mount();
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByTestId("reset"));
    vi.unstubAllGlobals();
    await tick(100);
    expect(localStorage.getItem(BEACON)).toBeNull();
  });
});
