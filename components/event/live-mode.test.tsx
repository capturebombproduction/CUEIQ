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
}));

import { LiveMode } from "./live-mode";

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
