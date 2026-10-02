// Live Mode — the screen that is literally on stage — rendered for the first time.
//
// Every one of these tests replaces a leg of the founder's manual two-device test:
// two laptops, a phone, a PA and someone in the room to notice the silence. What
// they have in common is that NONE of them is provable from a pure function. The
// held-key test is about the ORDER of two statements. The handoff tests are about a
// broadcast handler that only exists once the component has mounted and subscribed.
// The single-audio-source test is about how many times a property is written to an
// element that is never in the document. Round 10's most common defect was a fix
// that could not execute; a rendered trace from a real entry point is the only
// thing that catches that class.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
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
import { nowClock } from "@/lib/time";
import type { SetlistItem } from "@/lib/types";

// ── the one seam ─────────────────────────────────────────────────────────────
// vi.mock factories are hoisted above every binding in this file, so the client
// has to travel through vi.hoisted() rather than through a module-scope const.
const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

// Live Mode's per-show IndexedDB restore is the ONLY path that puts an object URL
// into `audioUrls` without a network fetch, and the viewer-follow test needs one
// track to be holdable. fake-indexeddb could carry it, but seeding a real store
// makes the URL appear on an unpredictable tick; this makes it one awaited flush.
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "./live-mode";
import { deleteAudio } from "@/lib/audio-store";
import { OfflineBanner } from "@/components/offline-banner";

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

const ITEMS = [makeItem(1), makeItem(2), makeItem(3)];

let supa: SupabaseFake;

/** The prop list is copied verbatim from app/(app)/events/[id]/live/page.tsx. */
function renderLive(over: Partial<React.ComponentProps<typeof LiveMode>> = {}) {
  return render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Seishin Kakumei One-Man"
      items={ITEMS}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
      {...over}
    />
  );
}

/** The live: channel the component opened. */
function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}

/** Only the show-state broadcasts — sync-request / setlist-changed ride the same channel. */
function stateSends(ch = live()) {
  return ch.sent.filter((s) => s.event === "state");
}

/** Mount + let every mount effect's promise (IndexedDB restore, authority probe) land. */
async function mountLive(over: Parameters<typeof renderLive>[0] = {}) {
  const view = renderLive(over);
  await act(async () => {});
  return view;
}

/** The crash-recovery snapshot, as writeLiveSnapshot() writes it. */
function seedSnapshot(over: Record<string, unknown> = {}) {
  localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      state: {
        running: false,
        begun: true,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: 0,
        currentIndex: 0,
        mode: "manual",
      },
      committed: { id: null, anchor: null },
      ended: false,
      isController: true,
      controllerSince: 1_000,
      savedAt: Date.now(),
      ...over,
    })
  );
}

/** A keydown as the browser delivers it, with a spy on the one call that matters. */
function pressKey(
  target: EventTarget,
  init: KeyboardEventInit
): { prevented: number } {
  const counter = { prevented: 0 };
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const real = ev.preventDefault.bind(ev);
  ev.preventDefault = () => {
    counter.prevented++;
    real();
  };
  act(() => {
    target.dispatchEvent(ev);
  });
  return counter;
}

/** N events: one real press followed by (n-1) OS auto-repeats of the same key. */
function holdKey(target: EventTarget, init: KeyboardEventInit, n: number): number {
  let prevented = 0;
  prevented += pressKey(target, { ...init, repeat: false }).prevented;
  for (let i = 1; i < n; i++) {
    prevented += pressKey(target, { ...init, repeat: true }).prevented;
  }
  return prevented;
}

beforeEach(() => {
  vi.useFakeTimers({
    // Deliberately NOT faking queueMicrotask / promises — every await in these
    // tests has to keep settling on its own. Date is faked so `controllerSince`
    // comparisons and the snapshot's 6h freshness window are deterministic.
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      // A refetch fires on SUBSCRIBED. Answer with the SAME rows: an empty answer
      // would take the "an empty read is not an empty table" branch and make every
      // later assertion about a setlist that may or may not still be there.
      setlist_items: ok(ITEMS),
      songs: ok([]),
      show_authority: ok([]),
    },
  });
  h.supa = supa;
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE HELD KEY — correctness by statement ORDER
//
// live-mode.tsx puts e.preventDefault() BEFORE `if (e.repeat) return;` in all
// three branches, and the comment above it records why: the first attempt
// returned on e.repeat at the TOP of the handler, which stopped the spam and
// made a held spacebar scroll the transport row off the screen mid-show, because
// Space is the browser's page-scroll key. Swapping those two lines back is
// invisible to tsc, to lint, and to every pure test.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a held key is one intention, not fifty", () => {
  it("Space: suppresses the page scroll on every repeat, but flips run exactly once", async () => {
    seedSnapshot();
    await mountLive();

    const prevented = holdKey(window, { code: "Space", key: " " }, 11);

    // 11 events, 11 suppressed page-scrolls — the part that must happen every time.
    expect(prevented).toBe(11);
    // …and exactly one broadcast state change — the part that must happen once.
    const sends = stateSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.running).toBe(true);
  });

  it("ArrowRight: a held key advances one item, not ten", async () => {
    seedSnapshot();
    await mountLive();

    const prevented = holdKey(window, { key: "ArrowRight", code: "ArrowRight" }, 11);

    expect(prevented).toBe(11);
    const sends = stateSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.currentIndex).toBe(1);
  });

  it("N advances the same single step as ArrowRight", async () => {
    seedSnapshot();
    await mountLive();

    holdKey(window, { key: "n", code: "KeyN" }, 11);

    const sends = stateSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.currentIndex).toBe(1);
  });

  it("on the LAST item the key is not consumed at all — it falls through", async () => {
    seedSnapshot({
      state: {
        running: false,
        begun: true,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: 0,
        currentIndex: ITEMS.length - 1,
        mode: "manual",
      },
    });
    await mountLive();

    const { prevented } = pressKey(window, {
      key: "ArrowRight",
      code: "ArrowRight",
      repeat: false,
    });

    expect(prevented).toBe(0);
    expect(stateSends()).toHaveLength(0);
  });

  it("ignores the key while the operator is typing in a field", async () => {
    seedSnapshot();
    await mountLive();
    const input = document.createElement("input");
    document.body.appendChild(input);

    const { prevented } = pressKey(input, { code: "Space", key: " ", repeat: false });

    expect(prevented).toBe(0);
    expect(stateSends()).toHaveLength(0);
    input.remove();
  });

  it("ignores a modified chord (Ctrl/Meta/Alt) — those belong to the browser", async () => {
    seedSnapshot();
    await mountLive();

    let prevented = 0;
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      prevented += pressKey(window, {
        code: "Space",
        key: " ",
        repeat: false,
        ...mod,
      }).prevented;
    }

    expect(prevented).toBe(0);
    expect(stateSends()).toHaveLength(0);
  });

  it("a VIEWER's keyboard drives nothing and broadcasts nothing", async () => {
    seedSnapshot({ isController: false });
    await mountLive();
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();

    const prevented = holdKey(window, { code: "Space", key: " " }, 3);

    expect(prevented).toBe(0);
    expect(stateSends()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE START GATE
//
// Starting before the first sync round-trip stamps a NEWER controllerSince than
// the real controller's, which hijacks a running show back to item 0 and mutes
// its speaker. The gate is timer-driven in four different ways and none of them
// had a test.
//
// The three constants below are TRANSCRIBED from live-mode.tsx, not imported from
// it (they are module-private there, and exporting a number only so a test can
// echo it back proves nothing). Transcribed copies normally rot — these cannot go
// quietly wrong, because every arm brackets its boundary: advance to N-1 and assert
// still DISABLED, advance the last 1ms and assert ENABLED. Widen the product's
// window and the "N-1 → disabled" half stays green while the "+1 → enabled" half
// fails; narrow it and the disabled half fails. Move the 2_000 in live-mode.tsx and
// the blast radius is both arms below that advance by it PLUS all five tests that
// go through startShowFromUi() — it advances the same 2_000 and then clicks, so a
// gate that has not opened leaves the button disabled and the click sends nothing.
// A drifted copy therefore shows up as a failure, not as a test that quietly passes
// against the wrong number.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the START gate", () => {
  const SETTLE_AFTER_SUBSCRIBED_MS = 2_000;
  const SETTLE_AFTER_CHANNEL_ERROR_MS = 3_000;
  const HARD_FALLBACK_MS = 6_000;

  const start = () => screen.getByTestId("start-show");

  it("is disabled until the sync round-trip settles, then enables", async () => {
    await mountLive();
    expect(start()).toBeDisabled();

    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    // Subscribing alone is not the gate — the reply WINDOW is.
    expect(start()).toBeDisabled();
    expect(live().lastSent("sync-request")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_SUBSCRIBED_MS);
    });
    expect(start()).toBeEnabled();
  });

  it("the hard fallback un-bricks START when the channel never subscribes at all", async () => {
    await mountLive();
    expect(live().status).toBeNull(); // nothing ever fired
    expect(start()).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(HARD_FALLBACK_MS - 1);
    });
    expect(start()).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    // An offline show must still be startable.
    expect(start()).toBeEnabled();
  });

  it("CHANNEL_ERROR enables START after its own (longer) delay", async () => {
    await mountLive();

    await act(async () => {
      live().setStatus("CHANNEL_ERROR", new Error("join failed"));
    });
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_CHANNEL_ERROR_MS - 1);
    });
    expect(start()).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(start()).toBeEnabled();
  });

  it("a SUBSCRIBED landing inside the error window CANCELS the error timer", async () => {
    await mountLive();

    await act(async () => {
      live().setStatus("CHANNEL_ERROR", new Error("transient"));
    });
    // The retry succeeds 100ms before the error timer would have fired.
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_CHANNEL_ERROR_MS - 100);
    });
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });

    // Past where the CANCELLED error timer sat: still gated, on the new window.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(start()).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_SUBSCRIBED_MS - 200);
    });
    expect(start()).toBeEnabled();
  });
});

/** Subscribe, settle the gate, press START, and hand back the show's start stamp. */
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

// ─────────────────────────────────────────────────────────────────────────────
// (c) TWO-DEVICE HANDOFF, without a second device
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · two-device handoff", () => {
  let media: MediaInstrumentation;

  beforeEach(() => {
    media = instrumentMediaElements();
  });

  it("steps down to viewer for a peer holding the newer claim, and goes quiet", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    expect(stateSends()).toHaveLength(1);
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();

    await act(async () => {
      live().emit("state", {
        sender: "peer-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: ts,
        itemStartedAt: ts,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        controllerSince: ts + 10_000, // a deliberate take-control, after ours
        ended: false,
      });
    });

    // 1. demoted
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    // 2. เครื่องเสียงคุมคนเดียว — the sound went with the control
    expect(media.state(media.first()!).muted).toBe(true);
    expect(media.state(media.second()!).muted).toBe(true);
    // 3. and it stopped talking: a viewer that keeps broadcasting is two controllers
    expect(stateSends()).toHaveLength(1);
  });

  // ── THE ATTRIBUTES THE TWO-DEVICE SMOKE READS ──────────────────────────────
  // desktop/scripts/run-smoke.mjs's "two-device" scenario runs the PA and the
  // joining phone as two separate Electron processes, and the ONLY thing it can
  // read across that boundary is the DOM. `data-cueiq-live-*` is that boundary.
  // Deleting or renaming one of these attributes would leave the smoke reporting
  // "Live Mode never mounted" — a failure that names the wrong file, twenty
  // minutes into a release. Here it is one red test, in three seconds, with the
  // attribute named.
  it("publishes what this device IS on the root, and keeps it in step", async () => {
    await mountLive();
    const root = () => document.querySelector("[data-cueiq-live]")!;
    expect(root).not.toBeNull();
    expect(root().getAttribute("data-cueiq-live-begun")).toBe("0");
    expect(root().getAttribute("data-cueiq-live-controller")).toBe("1");
    expect(root().getAttribute("data-cueiq-live-sound")).toBe("1");

    const ts = await startShowFromUi();
    expect(root().getAttribute("data-cueiq-live-begun")).toBe("1");
    expect(root().getAttribute("data-cueiq-live-index")).toBe("0");

    // …and they follow a demotion, which is the state the smoke's joining device
    // asserts on: not controller, not sounding, and standing on the CONTROLLER's
    // item rather than back at the first one.
    await act(async () => {
      live().emit("state", {
        sender: "peer-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: ts,
        itemStartedAt: ts,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        controllerSince: ts + 10_000,
        ended: false,
      });
    });
    expect(root().getAttribute("data-cueiq-live-controller")).toBe("0");
    expect(root().getAttribute("data-cueiq-live-sound")).toBe("0");
    expect(root().getAttribute("data-cueiq-live-index")).toBe("2");
  });

  it("THE JOINING PHONE: a peer with a NULL claim does not take the show", async () => {
    await mountLive();
    const ts = await startShowFromUi();

    await act(async () => {
      live().emit("state", {
        sender: "peer-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: ts + 5_000,
        itemStartedAt: ts + 5_000,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        // The phone that merely opened the page mid-show: begun adopted, never claimed.
        controllerSince: null,
        ended: false,
      });
    });

    // Still in control…
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    // …and exactly ONE re-assert went out, carrying OUR position, not theirs.
    const sends = stateSends();
    expect(sends).toHaveLength(2);
    expect(sends[1].payload.currentIndex).toBe(0);
    expect(sends[1].payload.startedAt).toBe(ts);
    expect(sends[1].payload.fromController).toBe(true);
  });

  // ── (d) A VERDICT IS NOT A PREFERENCE ──────────────────────────────────────
  // A tablet that joined one running show came back as the PA at the NEXT gig
  // with its output off, under a green "เสียงพร้อมครบ". The mute above is a
  // verdict about one moment; only the operator's own tap is a preference.
  it("an arbitration mute is NOT written to the device's saved sound preference", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    // What the operator's actual preference is on disk before the verdict.
    expect(localStorage.getItem("cueiq:soundOutput")).toBe("1");

    await act(async () => {
      live().emit("state", {
        sender: "peer-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: ts,
        itemStartedAt: ts,
        itemElapsedAtPause: null,
        currentIndex: 1,
        mode: "manual",
        controllerSince: ts + 10_000,
        ended: false,
      });
    });

    // The element really is muted for this show…
    expect(media.state(media.first()!).muted).toBe(true);
    // …and the device still remembers itself as a sound device for the next one.
    expect(localStorage.getItem("cueiq:soundOutput")).toBe("1");
  });

  it("the operator's OWN tap on the sound toggle IS remembered", async () => {
    await mountLive();
    expect(localStorage.getItem("cueiq:soundOutput")).toBe("1");

    await act(async () => {
      fireEvent.click(screen.getByTestId("sound-output-toggle"));
    });

    expect(localStorage.getItem("cueiq:soundOutput")).toBe("0");
    expect(media.state(media.first()!).muted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) SINGLE AUDIO SOURCE — "เสียงออกเครื่องเดียว", the zero-tolerance guarantee
//
// The viewer follows the controller's DISCRETE intent (which track, play/pause)
// and never imports its position again. The second half of this test is the
// no-desync guarantee: a later anchor for the SAME track must move nothing.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the sounding device owns its own playhead", () => {
  it("loads and seeks ONCE on a track change, and never again for the same track", async () => {
    const media = instrumentMediaElements();
    h.saved = [
      { itemId: "item-2", blob: new Blob(["audio"]), name: "track-2.wav", path: null },
    ];
    await mountLive();

    const anchor = Date.now();
    const controllerState = {
      sender: "pa-device",
      fromController: true,
      begun: true,
      running: true,
      startedAt: anchor - 60_000,
      itemStartedAt: anchor,
      itemElapsedAtPause: null,
      currentIndex: 1,
      mode: "manual",
      controllerSince: anchor - 1_000,
      ended: false,
      audioItemId: "item-2",
      audioPlaying: true,
    };

    await act(async () => {
      live().emit("state", { ...controllerState, sentAt: Date.now(), audioAnchor: anchor });
    });

    const primary = media.first()!;
    const writes = () => media.callsFor(primary);
    expect(writes().filter((c) => c.type === "src")).toHaveLength(1);
    expect(writes().filter((c) => c.type === "currentTime")).toHaveLength(1);
    expect(writes().filter((c) => c.type === "play")).toHaveLength(1);
    expect(media.state(primary).paused).toBe(false);

    // The SAME track, re-announced with an anchor 30s further on — a reconnect, a
    // hand-off, a controller that recomputed its own clock. Importing that would
    // be an audible mid-song jump in front of the room.
    await act(async () => {
      live().emit("state", {
        ...controllerState,
        sentAt: Date.now(),
        audioAnchor: anchor + 30_000,
      });
    });

    expect(writes().filter((c) => c.type === "src")).toHaveLength(1);
    expect(writes().filter((c) => c.type === "currentTime")).toHaveLength(1);
    expect(writes().filter((c) => c.type === "play")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) จบโชว์ MUST SILENCE THE PA
//
// The pause used to sit inside endShow's `if (s.running)` branch — and Manual
// deliberately leaves the previously-committed track sounding while the next row
// is cued (goto's manual branch sets running:false and touches no audio). So the
// one sequence every Manual show ends with, START → NEXT → จบโชว์, saved the run,
// released every wake lock and told Electron the show was over while the song kept
// coming out of the PA with nothing left on screen that would stop it.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · จบโชว์ stops the sound", () => {
  it("silences a track still sounding under a Manual cue, and says so on the wire", async () => {
    const media = instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null },
    ];
    await mountLive();
    await startShowFromUi();

    const primary = media.first()!;
    // The premise: START really did put audio out of this device.
    expect(media.state(primary).src).toBeTruthy();
    expect(media.state(primary).paused).toBe(false);

    // NEXT cues item 2 FROZEN and leaves item 1 playing — by design.
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    expect(stateSends().at(-1)!.payload.running).toBe(false);
    expect(media.state(primary).paused).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });

    // 1. this device is quiet — both elements, so a pre-roll can't outlive the show
    expect(media.state(primary).paused).toBe(true);
    expect(media.state(media.second()!).paused).toBe(true);
    // 2. …and the speaker device is told, on the message that already exists: the
    //    state broadcast's own audio intent, not a new "stop" event.
    const last = stateSends().at(-1)!;
    expect(last.payload.ended).toBe(true);
    expect(last.payload.audioPlaying).toBe(false);
  });

  it("still freezes the clock and silences a RUNNING show", async () => {
    const media = instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null },
    ];
    await mountLive();
    await startShowFromUi();
    const primary = media.first()!;

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });

    expect(media.state(primary).paused).toBe(true);
    const last = stateSends().at(-1)!;
    expect(last.payload.running).toBe(false);
    expect(last.payload.begun).toBe(true); // a freeze, not a reset
    expect(last.payload.ended).toBe(true);
    expect(last.payload.audioPlaying).toBe(false);
  });

  // ── จบโชว์ HAS TO REACH THE DISK, NOT JUST THE WIRE ────────────────────────
  // The snapshot effect is debounced 500 ms and its cleanup clearTimeout()s on
  // unmount. A Next client-side navigation off /events/[id]/live — the ordinary
  // way anyone leaves this page, including the "ออกจากโหมดไลฟ์" link — unmounts
  // without firing pagehide, so the flush-on-hide listener never runs either.
  // endShow's already-paused branch flushes by hand; its RUNNING branch used to
  // call apply() and trust the debounce, so ending a running show and walking off
  // the page inside half a second left running:true on disk. The next open of the
  // event then restored a finished show as a live one: wake lock re-armed, and the
  // sync-request reply telling every other device the show was back on.
  it("the RUNNING branch reaches the disk too — unmount with no pagehide, show still ended", async () => {
    instrumentMediaElements();
    const { unmount } = await mountLive();
    await startShowFromUi();

    // The premise: the debounce has already put the RUNNING show on disk.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!).state.running).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    // No timer advance and no pagehide — just the navigation.
    unmount();

    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!);
    expect(snap.state.running).toBe(false);
    expect(snap.state.begun).toBe(true); // จบโชว์ freezes, it does not reset
    expect(snap.ended).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) CRASH SNAPSHOT — the reply is the only observable proof it was read back
//
// A reload used to hand every restored device isController=true with a null
// claim, and used to forget that the show had already ended. Both fields are
// per-device, applied to refs, and rendered nowhere directly: the sync-request
// reply is where they become visible.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the crash-recovery snapshot restores the device's ROLE", () => {
  it("answers a sync-request as the viewer it was, with its claim and its ended flag", async () => {
    seedSnapshot({
      state: {
        running: false,
        begun: true,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: 0,
        currentIndex: 1,
        mode: "manual",
      },
      isController: false,
      controllerSince: 12_345,
      ended: true,
    });
    await mountLive();

    let delivered = 0;
    await act(async () => {
      delivered = live().emit("sync-request", { sender: "joining-phone" });
    });

    // 0 handlers would mean the component never registered — the failure this is hunting.
    expect(delivered).toBe(1);
    const reply = live().lastSent("state");
    expect(reply).toBeTruthy();
    expect(reply!.payload.fromController).toBe(false);
    expect(reply!.payload.controllerSince).toBe(12_345);
    expect(reply!.payload.ended).toBe(true);
    expect(reply!.payload.currentIndex).toBe(1);
  });

  it("a restored CONTROLLER answers as one", async () => {
    seedSnapshot({ isController: true, controllerSince: 54_321, ended: false });
    await mountLive();

    await act(async () => {
      live().emit("sync-request", { sender: "joining-phone" });
    });

    const reply = live().lastSent("state");
    expect(reply!.payload.fromController).toBe(true);
    expect(reply!.payload.controllerSince).toBe(54_321);
    expect(reply!.payload.ended).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A row swapped to another song ("เปลี่ยน" in the setlist builder) while this
// device held the old song's bytes under that row id. With no master for the new
// song, nothing replaced them, and Live Mode played the OLD song under the new
// title with the row showing ready (review 2026-10-01).
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a swapped row never plays the old song", () => {
  const A = { id: "songA", audio_path: "t/g/a.mp3", audio_name: "a.mp3" };
  const B = { id: "songB", audio_path: null, audio_name: null }; // just added, no master
  const heldA = () => [{ itemId: "item-1", blob: new Blob(["A-bytes"]), name: "a.mp3", path: "t/g/a.mp3" }];
  const fileButton = () =>
    screen.getAllByRole("button").find((b) => /ไฟล์เพลง/.test(b.getAttribute("title") ?? ""))!;

  beforeEach(() => {
    vi.mocked(deleteAudio).mockClear();
  });

  it("opening the show after the swap: the old bytes are not restored, and are deleted", async () => {
    const swapped = [makeItem(1, { song_id: "songB", title: "Track B" })];
    supa.setTable("setlist_items", ok(swapped));
    supa.setTable("songs", ok([A, B]));
    h.saved = heldA();
    await mountLive({
      items: swapped,
      songAudio: { songA: { path: A.audio_path, name: A.audio_name }, songB: { path: null, name: null } },
    });
    expect(deleteAudio).toHaveBeenCalledWith(EVENT_ID, "item-1");
    expect(fileButton().getAttribute("title")).toBe("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)");
  });

  it("a file the library does not know is KEPT — never drop show audio on a guess", async () => {
    // e.g. the desktop's offline cache, whose song rows can lack audio_path
    const row = [makeItem(1, { song_id: "songB", title: "Track B" })];
    supa.setTable("setlist_items", ok(row));
    supa.setTable("songs", ok([B]));
    h.saved = heldA();
    await mountLive({ items: row, songAudio: { songB: { path: null, name: null } } });
    expect(deleteAudio).not.toHaveBeenCalled();
    expect(fileButton().getAttribute("title")).toBe("เปลี่ยนไฟล์เพลง (อัปโหลดขึ้นคลาวด์)");
  });

  it("swapped while this screen is open: the setlist-changed refetch drops the old bytes", async () => {
    const before = [makeItem(1, { song_id: "songA", title: "Track A" })];
    supa.setTable("setlist_items", ok(before));
    supa.setTable("songs", ok([A]));
    h.saved = heldA();
    await mountLive({ items: before, songAudio: { songA: { path: A.audio_path, name: A.audio_name } } });
    expect(fileButton().getAttribute("title")).not.toBe("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)");
    expect(deleteAudio).not.toHaveBeenCalled();

    supa.setTable("setlist_items", ok([makeItem(1, { song_id: "songB", title: "Track B" })]));
    supa.setTable("songs", ok([A, B]));
    await act(async () => {
      live().emit("setlist-changed", {});
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});
    expect(deleteAudio).toHaveBeenCalledWith(EVENT_ID, "item-1");
    expect(fileButton().getAttribute("title")).toBe("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WARNING LADDER (lib/live-zone) — the card has to be fed the item's block
//
// The ladder itself is pinned in lib/live-zone.test.ts. What only a render can
// prove is that this screen passes the CURRENT item's block (buffers included)
// rather than a constant, and maps the zones onto the card it colours.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the warning ladder", () => {
  const SE = makeItem(1, {
    kind: "se",
    title: "Opening SE",
    duration_seconds: 80,
    buffer_before_seconds: 4,
    buffer_after_seconds: 8,
  });
  const heading = () => screen.getByRole("heading", { level: 2 });
  const card = () => heading().closest("[data-zone]") as HTMLElement;
  const root = () => document.querySelector("[data-cueiq-live]") as HTMLElement;
  const advance = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });

  it("a 1:32 SE starts neutral, then warns, urges and inverts at its own scaled thresholds", async () => {
    // Block 92 s = 4 + 80 + 8. The split is the point: a screen that fed the ladder
    // duration_seconds (80 → 40/20) instead of the block `remaining` runs on would
    // still be neutral at 46 s left, and this test would catch it. A second item, so
    // NEXT can actually be pressed when the overtime invite appears.
    const items = [SE, makeItem(2, { title: "Track 2" })];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    await startShowFromUi();

    /** the zone, and the card that wears it — never the old dimming pulse */
    const zoneIs = (zone: string) => {
      expect(card()).toHaveAttribute("data-zone", zone);
      expect(card()).not.toHaveClass("animate-pulse-ring");
    };

    // The old ladder painted this red ("เหลือน้อยกว่า 2 นาที") from its first second.
    expect(heading()).toHaveTextContent("Opening SE");
    expect(card()).toHaveTextContent("เวลาคงเหลือของรายการ");
    zoneIs("ok");
    expect(card()).toHaveClass("lit");

    // 50 s left: under a full song's 60 s cap, but NOT under this item's own 46 s —
    // a screen that fed liveZone a fixed block instead of the item's would warn here.
    await advance(42_000);
    zoneIs("ok");

    await advance(4_000); // 46 s left — half the block
    expect(card()).toHaveTextContent("เหลือไม่ถึง 46 วินาที");
    zoneIs("warn");
    expect(card()).toHaveClass("zone-warn"); // the frame step: the card stays dark

    await advance(21_000); // 25 s left — under 30, over this item's 23
    zoneIs("warn");

    await advance(2_000); // 23 s left — a quarter
    expect(card()).toHaveTextContent("เหลือไม่ถึง 23 วินาที");
    zoneIs("urgent");
    expect(card()).toHaveClass("zone-urgent");
    // URGENT is a low-luminance fill — only overtime ever becomes the light plate
    expect(card()).not.toHaveClass("alarm-plate");
    expect(root()).not.toHaveClass("zone-over");
    expect(screen.getByTestId("next")).not.toHaveClass("next-invite");

    await advance(23_000);
    expect(card()).toHaveTextContent("เลยเวลาแล้ว");
    zoneIs("over");
    expect(card()).toHaveClass("alarm-plate");
    expect(card()).not.toHaveClass("settled");
    // the screen frame + hazard rails, and the invitation to move on
    expect(root()).toHaveClass("zone-over");
    // …which is what swaps the page light to the alarm light: it must be inside
    expect(root().contains(document.querySelector(".spotlight"))).toBe(true);
    expect(screen.getByTestId("next")).toHaveClass("next-invite");
    expect(screen.getByTestId("next")).toBeEnabled();
    // overtime announces itself once
    expect(within(card()).getByRole("alert")).toHaveTextContent(/Overtime/);

    // Ten seconds of the full-luminance flip is enough to have been seen — and the
    // clock counts UP with a "+", never the "-" that reads as time left.
    await advance(10_000);
    expect(card()).toHaveClass("alarm-plate", "settled");
    expect(screen.getByRole("timer")).toHaveTextContent("+0:10");
  });

  it("never invites a press NEXT cannot take: the last item runs over with the key locked", async () => {
    supa.setTable("setlist_items", ok([SE]));
    await mountLive({ items: [SE] });
    await startShowFromUi();

    await advance(100_000);
    expect(card()).toHaveAttribute("data-zone", "over");
    expect(root()).toHaveClass("zone-over");
    expect(screen.getByTestId("next")).toBeDisabled();
    expect(screen.getByTestId("next")).not.toHaveClass("next-invite");
    // …and the card does not tell this device to press it either
    expect(card()).not.toHaveTextContent("กด NEXT เมื่อพร้อม");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PAGE LIGHT (v3 "Stage Wash", FINAL-SPEC-v3 §E.11 / §G.10)
//
// The immersive screen has no app frame, so it hangs its own light — and it has to
// hang it INSIDE the root, because overtime swaps the light to the neutral alarm
// light through `.zone-over { --spot: var(--alarm) }` on that root: a light mounted
// beside the root would stay band red through OVERTIME.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the page light", () => {
  const root = () => document.querySelector("[data-cueiq-live]") as HTMLElement;
  const TRAPS_FIXED = /(^|\s)(?:[\w-]+:)*(?:transform|transform-gpu|-?translate-|-?scale-|-?rotate-|-?skew-|blur|backdrop-|filter|will-change-transform|contain-|perspective)/;

  it("hangs ONE light, first in the root, aimed at the NOW column at stage size", async () => {
    await mountLive();
    const lights = document.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    const light = lights[0] as HTMLElement;
    expect(light.parentElement).toBe(root());
    expect(root().firstElementChild).toBe(light);
    expect(light).toHaveAttribute("aria-hidden", "true");
    expect(light).toHaveClass("no-print", "stage:[--spot-x:27%]");
    // its base aim is its own: this root sits inside the app frame, whose lg aim
    // (25 %, at the page title) it would otherwise inherit on an lg screen that is
    // not "stage" (a portrait iPad Pro)
    expect(light).toHaveClass("[--spot-x:50%]");
    // NOT isolated: an isolated root would paint this viewport-sized layer over
    // whatever sits above LiveMode in the page (the desktop's readiness card).
    expect(root()).not.toHaveClass("isolate");
  });

  it("nothing between the light and the viewport traps `position: fixed`", async () => {
    await mountLive();
    const light = document.querySelector(".spotlight");
    expect(light, "no light to walk up from — this would pass on nothing").not.toBeNull();
    const traps: string[] = [];
    for (let el = light?.parentElement; el; el = el.parentElement) {
      if (TRAPS_FIXED.test(el.className) || el.style.transform || el.style.filter) traps.push(el.className);
    }
    expect(traps).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DOCK, THE TOP BAR AND LIVE TOOLS (FINAL-SPEC-v2 §G.10)
//
// The desktop smoke clicks these by data-testid with querySelector, so each must
// exist exactly ONCE — jsdom has no CSS, so a copy hidden by a class would still
// be a second node here, exactly as it would be to the smoke.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the dock", () => {
  const count = (id: string) => screen.queryAllByTestId(id).length;

  it("before START the centre key is START; after it, every transport id exists exactly once", async () => {
    await mountLive();
    expect(screen.getByTestId("start-show")).toHaveClass("cut");
    for (const id of ["prev", "run-toggle", "next", "reset", "end-show"]) expect(count(id), id).toBe(0);

    await startShowFromUi();
    for (const id of ["prev", "run-toggle", "next", "reset", "end-show", "sound-output-toggle"]) {
      expect(count(id), id).toBe(1);
    }
    expect(count("start-show")).toBe(0);
    // NEXT took START's slot: the same chamfered key, so a thumb finds it again
    expect(screen.getByTestId("next")).toHaveClass("cut");
  });

  it("START's subtitle never prints '(undefined)' for a cached row that lost its kind", async () => {
    const bare = [makeItem(1, { title: "Overture", kind: undefined as never })];
    supa.setTable("setlist_items", ok(bare));
    await mountLive({ items: bare });
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("start-show")).toHaveTextContent("เริ่ม Overture");
    expect(screen.getByTestId("start-show")).not.toHaveTextContent("undefined");
  });

  // The key's subtitle is `truncate` inside the key's leading-none, in Kanit: a clip
  // box of +852/−147 units, and Kanit's stacked tone marks reach +1046, its ู −270.
  // The pre-start key read "เริม Kakumei Overture" (mai ek gone) on every show. The
  // padding widens the clip; the margins give the room back so nothing in the key
  // moves. jsdom has no layout: the room is what is pinned.
  it("START's and NEXT's Thai subtitles keep their tone marks inside the clip", async () => {
    const room = ["truncate", "py-[.25em]", "-mb-[.25em]", "mt-[calc(5px_-_.25em)]"];
    await mountLive();
    const startSub = screen.getByTestId("start-show").querySelector(".truncate");
    expect(startSub, "START has no subtitle").not.toBeNull();
    expect(startSub).toHaveClass(...room);
    expect(startSub).not.toHaveClass("mt-[5px]");

    await startShowFromUi();
    const nextSub = screen.getByTestId("next").querySelector(".truncate");
    expect(nextSub, "NEXT has no subtitle").not.toBeNull();
    expect(nextSub).toHaveClass(...room);
    expect(nextSub).not.toHaveClass("mt-[5px]");
  });

  // viewport-fit=cover: a fixed, edge-to-edge bar ignores the body's side padding,
  // so on an iPhone held sideways its keys sat in the notch / rounded corner. The
  // dock pads itself by the side insets (never less than its 16 px gutter).
  it("keeps its keys inside a landscape iPhone's side insets", async () => {
    await mountLive();
    const dock = document.querySelector(".dock") as HTMLElement;
    expect(dock).toHaveClass(
      "fixed",
      "pl-[max(1rem,env(safe-area-inset-left))]",
      "pr-[max(1rem,env(safe-area-inset-right))]"
    );
    expect(dock).not.toHaveClass("px-4");
  });
});

describe("LiveMode · the top bar", () => {
  it("leaves through a real link (the leave guard intercepts a[href]) inside the immersive top bar", async () => {
    await mountLive();
    const link = document.querySelector(`header.live-top a[href="/events/${EVENT_ID}"]`);
    expect(link).not.toBeNull();
    expect(link!.closest("[data-cueiq-live]")).not.toBeNull();
  });

  it("hosts the offline strip, so the page-level copy stands down and never pushes the screen", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      render(<OfflineBanner />); // the root layout's flow copy
      await mountLive();
      const strips = screen.getAllByTestId("offline-strip");
      expect(strips).toHaveLength(1);
      expect(strips[0].closest("header.live-top")).not.toBeNull();
    } finally {
      onLine.mockRestore();
    }
  });
});

describe("LiveMode · Live tools", () => {
  const sheet = () => screen.getByRole("dialog", { name: "Live tools", hidden: true });
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Live tools" }));

  it("opens from ⋯ with focus inside, holds the show's rarer controls, and closes on Escape", async () => {
    await mountLive();
    expect(sheet()).not.toBeVisible();

    await startShowFromUi();
    await act(async () => open());
    expect(sheet()).toBeVisible();
    expect(sheet()).toContainElement(document.activeElement as HTMLElement);
    expect(within(sheet()).getByTestId("end-show")).toBeTruthy();
    expect(within(sheet()).getByTestId("reset")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(sheet()).not.toBeVisible();
    // focus goes back to the key that opened it
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Live tools" }));
  });

  it("offers แจ้งปัญหา mid-show — there is no floating button, and this screen has no header", async () => {
    await mountLive({ userId: "u1", tenantId: "t1" });
    await act(async () => open());
    expect(within(sheet()).getByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeTruthy();
  });

  it("without an account to report as, the form is not offered", async () => {
    await mountLive();
    await act(async () => open());
    expect(within(sheet()).queryByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeNull();
  });

  // The header's theme switch was on this screen before the redesign; the header is
  // hidden here now, and leaving a running show to find it goes through the leave
  // guard. Presentation only: switching must not touch the show.
  it("offers Dark | Light mid-show, and switching it sends nothing to the show", async () => {
    document.documentElement.classList.add("dark");
    try {
      await mountLive();
      await startShowFromUi();
      await act(async () => open());
      const before = stateSends().length;
      await act(async () => {
        fireEvent.click(within(sheet()).getByRole("radio", { name: /Light/ }));
      });
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(sheet()).toBeVisible();
      expect(stateSends()).toHaveLength(before);
    } finally {
      document.documentElement.classList.add("dark");
      localStorage.removeItem("cueiq:theme");
    }
  });

  // The sheet is aria-modal and puts focus on its ปิด key; Space is how a keyboard
  // presses a focused button. The window's Live shortcuts must never see a key
  // pressed in here, or that Space starts the show behind the scrim.
  const root = () => document.querySelector("[data-cueiq-live]") as HTMLElement;

  // aria-modal promises focus stays in here. Without a wrap, Shift+Tab from ปิด went
  // to the dock key under the scrim (START, or Run/Pause mid-show) and the next
  // Space pressed it — the show started or paused behind the sheet. jsdom does not
  // move focus on Tab, so what is pinned is the wrap: prevented, and focus moved.
  it("Tab and Shift+Tab wrap inside the sheet and never reach the dock under the scrim", async () => {
    seedSnapshot(); // mid-show: Run/Pause is a live key right before the sheet
    await mountLive();
    await act(async () => open());
    const close = document.activeElement as HTMLElement;
    expect(close).toHaveAccessibleName("ปิด");

    // Shift+Tab from the first control wraps to the sheet's last one
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(close, { key: "Tab", code: "Tab", shiftKey: true });
    });
    expect(notPrevented, "Shift+Tab from ปิด was left to the browser").toBe(false);
    const last = document.activeElement as HTMLElement;
    expect(sheet()).toContainElement(last);
    expect(last).not.toBe(close);
    expect(screen.getByTestId("run-toggle")).not.toBe(last);

    // Tab from the last wraps back to the first
    await act(async () => {
      notPrevented = fireEvent.keyDown(last, { key: "Tab", code: "Tab" });
    });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(close);

    // in between, Tab is the browser's: ปิด → the next control is not hijacked
    await act(async () => {
      notPrevented = fireEvent.keyDown(close, { key: "Tab", code: "Tab" });
    });
    expect(notPrevented).toBe(true);
  });

  it("keeps the Live shortcuts out while open: Space on its focused ปิด never starts the show", async () => {
    await mountLive();
    // Open the START gate first, so a Space that leaked to the window WOULD start.
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("start-show")).toBeEnabled();

    await act(async () => open());
    const close = document.activeElement as HTMLElement;
    expect(close).toHaveAccessibleName("ปิด");
    await act(async () => {
      fireEvent.keyDown(close, { key: " ", code: "Space" });
    });
    await act(async () => {});

    expect(root()).toHaveAttribute("data-cueiq-live-begun", "0");
    expect(stateSends()).toHaveLength(0);
  });

  it("mid-show, Space / N / → pressed in the sheet neither run the clock nor walk the setlist", async () => {
    seedSnapshot(); // begun, paused, item 1 of 3, Manual, this device in control
    await mountLive();
    await act(async () => open());

    for (const key of [
      { key: " ", code: "Space" },
      { key: "n", code: "KeyN" },
      { key: "ArrowRight", code: "ArrowRight" },
    ]) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, key);
      });
    }

    expect(stateSends()).toHaveLength(0);
    expect(root()).toHaveAttribute("data-cueiq-live-index", "0");
    expect(screen.getByTestId("run-toggle")).toHaveTextContent("Run");
  });

  it("…nor from the Feedback form opened from it, which is portalled out of the sheet", async () => {
    seedSnapshot();
    await mountLive({ userId: "u1", tenantId: "t1" });
    await act(async () => open());
    await act(async () => {
      fireEvent.click(within(sheet()).getByTitle(/แจ้งปัญหา|มีคำตอบ/));
    });
    const form = screen.getByRole("dialog", { name: "Feedback" });
    const newTab = within(form).getByRole("button", { name: "ส่งใหม่" });

    for (const key of [
      { key: " ", code: "Space" },
      { key: "n", code: "KeyN" },
    ]) {
      await act(async () => {
        fireEvent.keyDown(newTab, key);
      });
    }

    expect(stateSends()).toHaveLength(0);
    expect(root()).toHaveAttribute("data-cueiq-live-index", "0");
  });

  it("carries the fade keys too, for the landscape phone whose NOW card has no room for them", async () => {
    await mountLive();
    await startShowFromUi();
    await act(async () => open());
    for (const name of ["Auto Mute", "MC", "Auto Loudness"]) {
      expect(within(sheet()).getByRole("button", { name })).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNNING ORDER — stage rows are idx · kind · title · planned start · length;
// the admin's row keys wait behind one Edit toggle there. jsdom has no CSS, so what
// is pinned here is the wiring the stylesheet reads, never a measurement.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the running order", () => {
  const order = () => screen.getByRole("heading", { name: "Running Order" }).closest("section") as HTMLElement;

  it("an admin's row keys sit behind one Edit toggle, which the stylesheet reads off the section", async () => {
    await mountLive();
    const toggle = within(order()).getByRole("button", { name: "แก้ไข" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(order()).toHaveAttribute("data-edit", "off");
    expect(order()).toHaveClass("group/ro");

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(order()).toHaveAttribute("data-edit", "on");
  });

  it("a member gets no Edit toggle and no row keys", async () => {
    await mountLive({ canEdit: false });
    expect(within(order()).queryByRole("button", { name: "แก้ไข" })).toBeNull();
    expect(within(order()).queryAllByTitle(/^(เลื่อนขึ้น|เลื่อนลง)$/)).toHaveLength(0);
  });

  it("every admin row keeps the same key slots, so a row with no audio file does not shift the column", async () => {
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2, { kind: "mc", title: "MC 1" }), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    // every title the file key can wear (row 1 may still be fetching its file)
    const fileKeys = screen.getAllByTitle(/^(มีไฟล์บนคลาวด์|โหลดไฟล์เพลง|เปลี่ยนไฟล์เพลง|กำลัง(ดาวน์|อัป)โหลด)/);
    expect(fileKeys).toHaveLength(3);
    const slots = fileKeys.map((b) => b.parentElement!.children.length);
    expect(new Set(slots).size).toBe(1);
  });

  it("prints each row's planned start once the show has a start: first run + the blocks before it", async () => {
    await mountLive();
    expect(screen.queryAllByTitle("เริ่มตามแผน")).toHaveLength(0); // nothing to count from yet

    const ts = await startShowFromUi();
    // ITEMS are three 4-minute blocks
    expect(screen.getAllByTitle("เริ่มตามแผน").map((el) => el.textContent)).toEqual(
      [0, 240, 480].map((s) => nowClock(new Date(ts + s * 1000)).slice(0, 5))
    );
  });
});

describe("LiveMode · the NEXT card", () => {
  it("prints NEXT's length once, on its label row, so the title keeps the column's width", async () => {
    await mountLive();
    const nextCard = screen.getByText("Next", { selector: ".nlabel" }).closest("section") as HTMLElement;
    const lengths = within(nextCard).getAllByText("4:00");
    expect(lengths).toHaveLength(1);
    expect(lengths[0].parentElement).toContainElement(within(nextCard).getByText("Next", { selector: ".nlabel" }));
    expect(nextCard).toHaveTextContent("Track 2");
  });

  // A one-line clip at the title's own leading (1.02 at stage: +910/−110 units in a
  // Barlow-first stack) shaves Kanit's ู and stacked tone marks off the item the crew
  // is preparing. Padding widens the clip; the negative margins (stage's 4 px gap
  // included) give the room back, so the card is exactly as tall as before.
  it("the NEXT title keeps its Thai marks inside its clip, and the card's height", async () => {
    await mountLive();
    const nextCard = screen.getByText("Next", { selector: ".nlabel" }).closest("section") as HTMLElement;
    const title = within(nextCard).getByText("Track 2");
    expect(title).toHaveClass("disp", "truncate", "py-[.25em]", "-my-[.25em]", "stage:mt-[calc(4px_-_.25em)]");
    expect(title).not.toHaveClass("stage:mt-1");
  });
});

describe("LiveMode · a viewer device", () => {
  it("keeps its sound toggle beside the viewer banner, and ขอควบคุม only while it outputs sound", async () => {
    seedSnapshot({ isController: false });
    await mountLive();
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    expect(screen.getByTestId("sound-output-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("request-control")).toBeInTheDocument();

    // เครื่องเสียงคุมคนเดียว: a muted viewer cannot take the show
    await act(async () => {
      fireEvent.click(screen.getByTestId("sound-output-toggle"));
    });
    expect(screen.queryByTestId("request-control")).toBeNull();
  });
});

// The status row on a 360 px phone leaves the readiness chip ~88 px of the ~109 it
// wants. Word and count shared ONE truncating span, so the ellipsis ate the count
// first ("พร้อม 1…", "ในเครื่อ…") — the number is the whole point of the chip.
describe("LiveMode · the readiness chip", () => {
  it("truncates the word, never the count", async () => {
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    const chip = screen.getByTitle(/^(เสียงในเครื่องนี้|กำลังโหลดเสียงลงเครื่อง)/);
    const count = within(chip).getByText("0/1");
    expect(count).toHaveClass("num", "shrink-0");
    expect(count.closest(".truncate"), "the count sits inside the span that truncates").toBeNull();
    const word = within(chip).getByText(/^(ในเครื่อง|กำลังโหลด)$/);
    expect(word).toHaveClass("min-w-0", "truncate");
    // alone on its line now (no 16 px number beside it to lift the line box), the
    // word's clip needs its own room for the tone mark on เครื่อง
    expect(word).toHaveClass("py-[.25em]", "-my-[.25em]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE REDESIGN MOVED OUT OF REACH (3ddf617 → the Black Stage screen)
//
// Each of these was on the old countdown card or status area, on every screen and
// for every role, and the restyle left it behind a closed sheet, a hover tooltip or
// a breakpoint no phone matches. jsdom has no CSS, so where a breakpoint decides it,
// what is pinned is the class the stylesheet reads.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · what a show needs stays where the show can reach it", () => {
  const root = () => document.querySelector("[data-cueiq-live]") as HTMLElement;
  const sheet = () => screen.getByRole("dialog", { name: "Live tools", hidden: true });
  const openTools = () => fireEvent.click(screen.getByRole("button", { name: "Live tools" }));
  const nowCard = () => screen.getByRole("heading", { level: 2 }).closest("[data-zone]") as HTMLElement;
  const READINESS = /^(เสียงในเครื่องนี้|กำลังโหลดเสียงลงเครื่อง)/;
  const LANDSCAPE_PHONE = "[@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]";

  it("the landscape-phone layout is a touch screen's: a short laptop window keeps the fades on NOW", async () => {
    // Keyed on height alone, a 1366×768 laptop's Chrome (or the .exe on a 768 px
    // screen) got the phone layout, which takes the fade row and the cue note off
    // the NOW card. ONE query everywhere, or the card's fades and Live tools' copy
    // could both show — or neither.
    await mountLive();
    await startShowFromUi();
    const rules = [root(), ...Array.from(root().querySelectorAll("*"))]
      .flatMap((n) => (n.getAttribute("class") ?? "").split(/\s+/))
      .filter((t) => t.includes("orientation:landscape"));
    expect(rules.length).toBeGreaterThan(20);
    expect(new Set(rules.map((r) => r.slice(0, r.indexOf("]:") + 1)))).toEqual(new Set([LANDSCAPE_PHONE]));
    // the sheet's copy of the fades is the card's mirror image under that same query
    const sheetFades = within(sheet()).getByRole("button", { name: "Auto Mute", hidden: true }).parentElement!;
    expect(sheetFades).toHaveClass("hidden", `${LANDSCAPE_PHONE}:grid`);
    // (the desktop Show Runner sizes this root by its class — desktop/src/pages/live.tsx)
    expect(root()).toHaveClass("live-root", "stage:h-[100dvh]");
  });

  it("Live tools carries the ON-NOW item's whole cue and who is on which mic", async () => {
    // 3ddf617 listed "1 → Ploy" and the full note on the countdown card; the new
    // NOW card has one truncated note line (none at all in overtime or on a phone
    // held sideways) and no mics, and NEXT has moved on to the item after.
    const SCRIPT =
      "MC: ขอบคุณทุกคนที่มาวันนี้ — เพลงต่อไปเป็นเพลงใหม่ ขอให้ทุกคนยกไฟขึ้นพร้อมกันตอนท่อนฮุก";
    const items = [
      makeItem(1, {
        kind: "mc",
        title: "MC 1",
        notes: SCRIPT,
        mic_slots: [
          { mic: "1", member: "Ploy" },
          { mic: "3", member: "Mint" },
        ],
      }),
      makeItem(2),
      makeItem(3),
    ];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    await startShowFromUi();
    await act(async () => openTools());
    expect(within(sheet()).getByText(SCRIPT)).toBeTruthy();
    expect(within(sheet()).getByText("Ploy")).toBeTruthy();
    expect(within(sheet()).getByText("Mint")).toBeTruthy();
    // …and nowhere else is "who is on 1 right now" printed: NEXT is item 2's
    expect(screen.getAllByText("Ploy")).toHaveLength(1);
  });

  it("a member running the show on a phone still sees, before START, that tracks are not on this device", async () => {
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items, canEdit: false });
    expect(root()).toHaveAttribute("data-cueiq-live-controller", "1");
    const chip = screen.getByTitle(READINESS);
    // 3ddf617's amber banner showed on every device; `hidden stage:inline-flex`
    // took it off every phone for anyone who is not an admin.
    expect(chip).not.toHaveClass("hidden");
    // the โหมดซ้อม chip gives way below stage (its sentence is first in Live tools)
    expect(screen.getByTitle(/^โหมดซ้อม/)).toHaveClass("hidden", "stage:inline-flex");
  });

  it("…and when every track is on the device, the phone row keeps โหมดซ้อม instead", async () => {
    await mountLive({ canEdit: false }); // no audio at all: nothing to be missing
    expect(screen.queryByTitle(READINESS)).toBeNull();
    expect(screen.getByTitle(/^โหมดซ้อม/)).not.toHaveClass("hidden");
  });

  it("a viewer that is the sound device is told which tracks it does not hold; a muted one is not", async () => {
    seedSnapshot({ isController: false });
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    const banner = screen.getByTestId("viewer-banner");
    expect(within(banner).getByTitle(READINESS)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sound-output-toggle"));
    });
    expect(within(screen.getByTestId("viewer-banner")).queryByTitle(READINESS)).toBeNull();
  });

  it("an iPhone/iPad sound host is told, beside the fade keys themselves, that they cannot change its level", async () => {
    // iOS: HTMLMediaElement.volume accepts the write and keeps 1. The standing
    // decision (iOS volume: ช่างมัน) is that the app SAYS so — 3ddf617 said it right
    // above Auto Mute / MC; the redesign put it in the closed Live tools sheet.
    const proto = HTMLMediaElement.prototype;
    const saved = Object.getOwnPropertyDescriptor(proto, "volume");
    Object.defineProperty(proto, "volume", { configurable: true, get: () => 1, set: () => {} });
    try {
      await mountLive();
      await startShowFromUi();
      expect(within(nowCard()).getByRole("button", { name: "Auto Mute" })).toBeTruthy();
      expect(nowCard()).toHaveTextContent(/ปรับ “ระดับเสียง” ในแอปไม่ได้/);

      // the remote with its sound off is not the device whose level is dead
      await act(async () => {
        fireEvent.click(screen.getByTestId("sound-output-toggle"));
      });
      expect(nowCard()).not.toHaveTextContent(/ปรับ “ระดับเสียง” ในแอปไม่ได้/);
    } finally {
      if (saved) Object.defineProperty(proto, "volume", saved);
      else delete (proto as unknown as Record<string, unknown>).volume;
    }
  });

  it("a browser whose volume works gets no such warning", async () => {
    await mountLive();
    await startShowFromUi();
    expect(within(nowCard()).getByRole("button", { name: "Auto Mute" })).toBeTruthy();
    expect(nowCard()).not.toHaveTextContent(/ปรับ “ระดับเสียง” ในแอปไม่ได้/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 15 · THE LIVE SEAMS THE AUDIT FOUND (CQ-06 wording, CQ-11, CQ-15, CQ-16,
// CQ-18, CQ-19, CQ-21)
//
// jsdom evaluates no media query and has no layout, so none of the geometry here is
// measured — what is pinned is the class the stylesheet reads (and a class that
// compiles: the preset's raw `stage` screen drops every min-* / max-* variant, which
// is why every width / height guard below is an arbitrary @media variant). The
// real-browser numbers belong to the harness (probe6, probe11, ov5, ev_chip). The
// one behaviour here, the scroll lock under Live tools, is plain DOM.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · round 15 seams", () => {
  const root = () => document.querySelector("[data-cueiq-live]") as HTMLElement;
  const sheet = () => screen.getByRole("dialog", { name: "Live tools", hidden: true });
  const openTools = () => fireEvent.click(screen.getByRole("button", { name: "Live tools" }));
  const nowCard = () => screen.getByRole("heading", { level: 2 }).closest("[data-zone]") as HTMLElement;
  const nextCard = () => screen.getByText("Next", { selector: ".nlabel" }).closest("section") as HTMLElement;
  const order = () => screen.getByRole("heading", { name: "Running Order" }).closest("section") as HTMLElement;

  it("CQ-15: NEXT holds 300 px, the running order gives ground below 1175 px (never under 290), and the fade keys are 14 px until the window is 1060 wide", async () => {
    await mountLive();
    await startShowFromUi();
    const board = nowCard().parentElement as HTMLElement;
    expect(board).toHaveClass("stage:grid-cols-[minmax(0,1fr)_300px_clamp(290px,calc(40vw_-_150px),320px)]");
    // the 270 px floor left the row with the NEXT chip 48 px of title and, in edit mode,
    // 0 px between its marks and the ▲▼ keys (measured at 1024)
    expect(board.className).not.toContain("clamp(270px");
    // NEXT never shrinks: its label row (NEXT, the index, a kind chip, a 48 px length)
    // is ~260 px for a 12:00 block, and a 250 px card spilled the length over the
    // running order at 1024 -> 1194 (measured: the first CQ-15 cut did exactly that)
    expect(board.className).not.toMatch(/clamp\(250px/);
    expect(board.className).not.toContain("24vw");
    // the running order: the approved 320 px from 1175 px up (both iPads, 1180 and 1194,
    // keep their layout), 290 px at the narrow end. Evaluate the formula it carries.
    const m = /_clamp\((\d+)px,calc\((\d+)vw_-_(\d+)px\),(\d+)px\)\]/.exec(board.className);
    expect(m).not.toBeNull();
    const [lo, vw, off, hi] = m!.slice(1).map(Number);
    const ro = (w: number) => Math.min(hi, Math.max(lo, (vw / 100) * w - off));
    expect(ro(1024)).toBe(290);
    expect(ro(1050)).toBe(290);
    expect(ro(1100)).toBe(290); // where 40vw - 150 takes over from the floor
    expect(ro(1133)).toBeCloseTo(303.2, 5); // the mini's landscape width: not the floor's business
    expect(ro(1175)).toBe(320);
    expect(ro(1180)).toBe(320);
    expect(ro(1194)).toBe(320);
    expect(ro(1366)).toBe(320);
    // monotonic: the running order never gets narrower as the window grows
    for (let w = 900; w < 1400; w += 10) expect(ro(w + 10)).toBeGreaterThanOrEqual(ro(w));
    // …and the floor costs NOW nothing it cannot spare. NOW is what the two side columns
    // leave: the window less the board's 20 px side padding and two 16 px gaps (72),
    // NEXT's 300 and the order. Its fade keys sit in the card's inner width (24 px of
    // padding a side) in a 1.05fr / .72fr / 1.25fr row with two 3 px gaps, and "Auto
    // Loudness" is the widest: measured 123.4 px at 14 px (Barlow Condensed 800, icon,
    // gap, padding) and 136.4 px at 16 px. Evaluated here for every window from 1024
    // (the narrowest iPad) with 3 px to spare.
    const now = (w: number) => w - 72 - 300 - ro(w);
    const autoLoudness = (w: number) => (1.25 / (1.05 + 0.72 + 1.25)) * (now(w) - 48 - 6);
    const need = (w: number) => (w < 1060 ? 123.4 : 136.4);
    expect(now(1024)).toBe(362);
    for (let w = 1024; w <= 1400; w++) expect(autoLoudness(w), `${w} px`).toBeGreaterThanOrEqual(need(w) + 3);
    // the running-order row at 1024 (inner width = the column less 40 px of padding):
    // the NEXT row's title = column - 222 (was 48 px at 270); in edit mode the row's
    // body is column - 196 wide and its marks (the chip, a gap and the 36 px length)
    // need 80, so what is left before the ▲▼ keys is column - 270 once the 6 px gap
    // is counted (was -0.1 px at 270: touching)
    expect(ro(1024) - 222).toBeGreaterThanOrEqual(68);
    expect(ro(1024) - 270).toBeGreaterThanOrEqual(19);
    // the old fixed pair is gone, or NOW would still get only the leftover at 1024
    expect(board.className).not.toContain("_300px_320px");
    for (const name of ["Auto Mute", "MC", "Auto Loudness"]) {
      const key = within(nowCard()).getByRole("button", { name });
      expect(key, name).toHaveClass("!text-[14px]", "stage:[@media(min-width:1060px)]:!text-[16px]");
      expect(key, name).not.toHaveClass("stage:!text-[16px]");
    }
  });

  it("CQ-16: under 390 px the readiness word steps aside whole; the count and the full sentence stay", async () => {
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    const chip = screen.getByTitle(/^(เสียงในเครื่องนี้|กำลังโหลดเสียงลงเครื่อง)/);
    const word = within(chip).getByText(/^(ในเครื่อง|กำลังโหลด)$/);
    expect(word).toHaveClass("[@media(max-width:389.98px)]:sr-only");
    // out of the layout but not out of the accessible text: display:none would leave a
    // screen reader the bare "0/1"
    expect(word.className).not.toContain("hidden");
    expect(chip).toHaveTextContent(/(ในเครื่อง|กำลังโหลด)\s*0\/1/);
    // never the count: it is the whole point of the chip, and the icon beside it stays
    const count = within(chip).getByText("0/1");
    expect(count.className).not.toContain("hidden");
    expect(chip.querySelector("svg")).not.toBeNull();
    // the sentence the word no longer carries is on the chip's title
    expect(chip.getAttribute("title")).toMatch(/0\/1/);
  });

  describe("CQ-18 · the page under the Live tools sheet", () => {
    let savedScrollY: PropertyDescriptor | undefined;
    let scrollTo: ReturnType<typeof vi.spyOn>;
    let y = 0;
    beforeEach(() => {
      y = 240;
      savedScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
      Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
      scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      document.documentElement.style.overflow = "";
    });
    afterEach(() => {
      scrollTo.mockRestore();
      if (savedScrollY) Object.defineProperty(window, "scrollY", savedScrollY);
      else delete (window as unknown as Record<string, unknown>).scrollY;
      document.documentElement.style.overflow = "";
    });

    it("is frozen while the sheet is open, and put back where it was when it closes", async () => {
      await mountLive();
      expect(document.documentElement.style.overflow).toBe("");
      await act(async () => openTools());
      expect(document.documentElement.style.overflow).toBe("hidden");

      y = 880; // something moved the page while it was frozen (iOS ignores overflow on <html>)
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      });
      expect(document.documentElement.style.overflow).toBe("");
      expect(scrollTo).toHaveBeenCalledWith(0, 240);
    });

    it("gives back a page that had its own overflow, and leaves nothing frozen if the screen unmounts open", async () => {
      document.documentElement.style.overflow = "scroll";
      const { unmount } = await mountLive();
      await act(async () => openTools());
      expect(document.documentElement.style.overflow).toBe("hidden");
      unmount();
      expect(document.documentElement.style.overflow).toBe("scroll");
    });

    it("its scrim takes no touch drag and chains no scroll to the page", async () => {
      await mountLive();
      const scrim = sheet().previousElementSibling as HTMLElement;
      expect(scrim).toHaveClass("absolute", "inset-0", "touch-none", "overscroll-none");
      await act(async () => openTools());
      await act(async () => {
        fireEvent.click(scrim);
      });
      expect(sheet()).not.toBeVisible(); // a tap on it still closes the sheet
    });
  });

  it("CQ-19: the SHOW slab is a size container and drops its duplicate elapsed row only when IT is too short; both tiles stay", async () => {
    await mountLive();
    const slab = screen.getByText("Show", { selector: ".nlabel" }).closest("section") as HTMLElement;
    // the top bar prints ผ่านไป; this is the 50 px copy of it beside the planned total
    const elapsed = slab.querySelector(".items-baseline") as HTMLElement;
    expect(elapsed).not.toBeNull();
    // the slab asks, not the window: a viewport rule hid the row on an 820 px iPad whose
    // Safari toolbar leaves 740, while the slab had room ("/ 12:00" is nowhere else)
    expect(elapsed.className).not.toContain("@media");
    expect(elapsed.className).not.toContain("799.98");
    // stage only: below it the slab is display:none and nothing is contained
    expect(slab).toHaveClass("hidden", "stage:flex", "stage:[container-type:size]");
    expect(slab.className).not.toMatch(/(^|\s)\[container-type:size\]/);
    // the threshold derives from the slab's content. A query reads the CONTENT box
    // (the slab's 14 + 16 px of padding are outside it), and what has to fit is the
    // label (22) + 8 + the row (54: the 50 px numerals baseline-aligned with the
    // 24 px / 36 px-line total) + 12 + the tiles (62.1 = 12 + 16.5 + 33.6): 158.1,
    // measured as a 188.1 px slab. A few px over, never under, and not far over.
    // (matched with plain string tests, never a literal shaped like the variant: Tailwind
    // scans components/** including this file, and a regex literal that looked like an
    // arbitrary variant was compiled into an invalid at-rule in the shipped web + .exe CSS)
    const rule = Array.from(elapsed.classList).find((c) => c.startsWith("[") && c.includes("container_") && c.includes("max-height") && c.endsWith(":hidden"));
    expect(rule, "the row hides on a container query").toBeDefined();
    const threshold = Number(/max-height:([\d.]+)px/.exec(rule!)![1]);
    const needed = 22 + 8 + 54 + 12 + 62.1;
    expect(threshold).toBeGreaterThanOrEqual(needed + 2);
    expect(threshold).toBeLessThanOrEqual(needed + 8);
    // the tiles alone: 22 + 12 + 62.1 = 96.1 (126.1 with the padding) — they never hide
    const tiles = Array.from(slab.querySelectorAll(".well"));
    expect(tiles).toHaveLength(2);
    for (const t of tiles) expect(t.className).not.toContain("max-height");
    // nothing sizes to the slab's content (a size container ignores it): flex-1 / min-h-0
    // in a column that stretches over a grid row of minmax(0,1fr), on a board that is
    // flex-1 / min-h-0 in a root with a definite stage height
    expect(slab).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    const column = slab.parentElement as HTMLElement;
    expect(column).toHaveClass("flex-col", "stage:min-h-0");
    const board = column.parentElement as HTMLElement;
    expect(board).toHaveClass("stage:grid", "stage:grid-rows-[minmax(0,1fr)]", "stage:min-h-0", "stage:flex-1");
    expect(board.parentElement).toBe(root());
    expect(root()).toHaveClass("stage:h-[100dvh]");
  });

  it("CQ-21: the dock's key row is as wide as the cards above it, not the 2xl a portrait iPad overshoots", async () => {
    await mountLive();
    const row = screen.getByTestId("start-show").parentElement as HTMLElement;
    expect(row.closest(".dock")).not.toBeNull();
    expect(row).toHaveClass("mx-auto", "max-w-[40rem]", "stage:max-w-none");
    expect(row).not.toHaveClass("max-w-2xl");
    // the landscape phone's root is max-w-none, so its cards never matched the row
    // anyway: it keeps the 2xl it always had (only the portrait iPad moves)
    expect(row).toHaveClass("[@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:max-w-2xl");
    // the cards: the root's 42rem less its 1rem gutters each side = 40rem
    expect(root()).toHaveClass("max-w-2xl", "px-4");
  });

  it("CQ-06: NEXT with no per-song mic slots says the mics stay as they are, never that there are none", async () => {
    await mountLive();
    expect(nextCard()).toHaveTextContent("— ไมค์เหมือนเดิม —");
    expect(nextCard()).not.toHaveTextContent("ไม่มีไมค์ที่ต้องเตรียม");
  });

  it("CQ-06: …and a NEXT that does carry mic slots prints them, with neither sentence", async () => {
    const items = [
      makeItem(1),
      makeItem(2, { mic_slots: [{ mic: "4", member: "Ploy" }] }),
      makeItem(3),
    ];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    expect(within(nextCard()).getByText("Ploy")).toBeTruthy();
    expect(nextCard()).not.toHaveTextContent("ไมค์เหมือนเดิม");
    expect(nextCard()).not.toHaveTextContent("ไม่มีไมค์ที่ต้องเตรียม");
  });

  it("CQ-11: a long running-order title wraps to a second line on a phone before it is cut, and stays one line on stage", async () => {
    const LONG = "[SYSTEM_BOOT] SE (Overture)";
    const items = [makeItem(1, { title: LONG }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    const title = within(order()).getByText(LONG);
    expect(title).toHaveClass("min-w-0", "line-clamp-2", "break-words");
    // stage hands the one-line clip back (truncate must come back AFTER line-clamp-none
    // in the stylesheet — tailwind orders them, the composed build is the harness's)
    expect(title).toHaveClass("stage:line-clamp-none", "stage:truncate", "stage:flex-1");
    // a base `truncate` (nowrap) would make the line-clamp inert on a phone
    expect(title).not.toHaveClass("truncate");
  });
});
