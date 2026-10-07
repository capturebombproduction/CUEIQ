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

import { toast } from "sonner";
import { LiveMode } from "./live-mode";
import { deleteAudio } from "@/lib/audio-store";
import { OfflineBanner } from "@/components/offline-banner";
import { resetSongCoverCache } from "@/lib/song-covers";

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

/** Mount a page that the device running the show (another one) has made a VIEWER:
 *  the PA announces a show it started a minute ago, standing on item `index`. */
async function mountViewer(over: Parameters<typeof renderLive>[0] = {}, index = 0) {
  const view = await mountLive(over);
  const t = Date.now();
  await act(async () => {
    live().emit("state", {
      sender: "pa-device",
      sentAt: t,
      fromController: true,
      begun: true,
      running: true,
      startedAt: t - 60_000,
      itemStartedAt: t - 10_000,
      itemElapsedAtPause: null,
      currentIndex: index,
      mode: "manual",
      controllerSince: t - 60_000,
      ended: false,
    });
  });
  // the run it watches: the PA's claim
  return Object.assign(view, { run: t - 60_000 });
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
    await mountViewer();
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    const before = stateSends().length;

    const prevented = holdKey(window, { code: "Space", key: " " }, 3);

    expect(prevented).toBe(0);
    expect(stateSends()).toHaveLength(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE START GATE
//
// Starting before the first sync round-trip begins a SECOND show on this device
// (item 0, its own sound) while one is already running elsewhere. Two different runs
// move nobody (they both warn), so the gate is what stops the second from existing.
// The gate is timer-driven in four different ways and none of them
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

  it("only the device RUNNING a show opens it early: an older build's viewer reply does not", async () => {
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      live().emit("state", {
        sender: "old-build-viewer",
        sentAt: Date.now(),
        fromController: false,
        begun: true,
        running: true,
        startedAt: Date.now() - 60_000,
        itemStartedAt: Date.now() - 10_000,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        controllerSince: null,
        ended: false,
      });
    });
    expect(start()).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_SUBSCRIBED_MS);
    });
    expect(start()).toBeEnabled();
  });

  // พี่ 2026-10-04: the device that started the show keeps it. START here while another
  // device holds it (its heartbeat is fresh) used to ASK "reset that show and silence
  // that device?" - a take-over by confirm. Now it is refused.
  it("is refused - never a confirm-to-reset - while another device holds the show", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_AFTER_SUBSCRIBED_MS);
    });
    await act(async () => {
      fireEvent.click(start());
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(stateSends()).toHaveLength(0);
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-begun")).toBe("0");
    confirm.mockRestore();
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
// (c) TWO DEVICES, without a second device
//
// พี่ 2026-10-04: the device that STARTED the show keeps it - it drives and it sounds.
// Every device that opens the page after it only watches, and nothing it does reaches
// the first one. There is no take-over. Two DIFFERENT runs are never settled by moving
// one of them: both keep what they run and both say so (lib/live-arbitration.ts).
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · two devices: the first one keeps the show", () => {
  let media: MediaInstrumentation;

  beforeEach(() => {
    media = instrumentMediaElements();
  });

  /** Another device running ITS OWN show (a different claim). */
  const otherRun = (claim: number, over: Record<string, unknown> = {}) => ({
    sender: "phone",
    sentAt: Date.now(),
    fromController: true,
    begun: true,
    running: true,
    startedAt: claim,
    itemStartedAt: claim,
    itemElapsedAtPause: null,
    currentIndex: 3,
    mode: "manual",
    controllerSince: claim,
    ended: false,
    deviceLabel: "iPhone ของมุก",
    ...over,
  });

  // A second START (a device that started its own show while it could not hear this
  // one, or two presses at once) used to win - the newer claim, which was ขอควบคุม.
  it("a device running a DIFFERENT run (a later START): nothing moves - this one keeps the show and says so", async () => {
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts + 10_000));
    });
    // still the controller, still sounding, still where it was, taking nothing from it
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(media.state(media.first()!).muted).toBe(false);
    expect(media.state(media.first()!).paused).toBe(false);
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index")).toBe("0");
    // nobody is to yield, so nobody is told to: no re-assert
    expect(stateSends()).toHaveLength(1);
    // the warning names the other device, when its run began, and that it is playing
    const warning = screen.getByTestId("run-conflict");
    expect(warning).toHaveTextContent("iPhone ของมุก");
    expect(warning).toHaveTextContent("รีเซ็ต");
    expect(warning).toHaveTextContent("เครื่องนั้นกำลังเล่นอยู่");
  });

  // Both are controllers while two runs are up, and the setlist is one table: the second
  // run's reorder would move the first run's NEXT. No live edits on either side.
  it("while two runs are up, neither side edits the setlist", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    expect(screen.getAllByTitle(/ไฟล์เพลง/).length).toBeGreaterThan(0);
    await act(async () => {
      live().emit("state", otherRun(ts + 10_000));
    });
    expect(screen.queryByTitle(/ไฟล์เพลง/)).toBeNull();
    expect(screen.queryByTitle(/แสดงปุ่มแก้ไขของแต่ละแถว/)).toBeNull();
  });

  // The review of 93d4979: under "the earlier claim wins", a phone back with this
  // afternoon's rehearsal took tonight's show off the PA.
  it("…and an EARLIER run (a phone back with this afternoon's rehearsal) moves nothing either", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts - 3 * 3600_000));
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-controller")).toBe("1");
    expect(screen.getByTestId("run-conflict")).toBeInTheDocument();
  });

  it("…whatever the other device's clock says", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts - 60_000, { sentAt: Date.now() - 120_000 }));
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-conflict")).toBeInTheDocument();
  });

  it("while two runs are up it re-sends its own state, so the other screen keeps its warning", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts + 10_000));
    });
    expect(stateSends()).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(stateSends().length).toBeGreaterThan(1);
    expect(stateSends().at(-1)!.payload.controllerSince).toBe(ts);
  });

  it("the warning goes when the other run is reset - and once it has gone quiet", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts + 10_000));
    });
    expect(screen.getByTestId("run-conflict")).toBeInTheDocument();
    await act(async () => {
      live().emit("state", otherRun(ts + 10_000, { begun: false, running: false, startedAt: null, controllerSince: null, resetRun: ts + 10_000 }));
    });
    expect(screen.queryByTestId("run-conflict")).toBeNull();

    // again, and this time the other page simply closes: no word from it for 30 s
    await act(async () => {
      live().emit("state", otherRun(ts + 20_000));
    });
    expect(screen.getByTestId("run-conflict")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.queryByTestId("run-conflict")).toBeNull();
  });

  // Two tabs restored from ONE snapshot hold the SAME run: either may drive it, so one
  // steps down and watches the very same show - the one NOT making the sound (the other
  // would have to be tapped to sound), else by id.
  it("the SAME run on a tab that opened EARLIER: this one (the copy) steps down, whatever the ids", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts, { sender: "0000-first-tab", currentIndex: 0, openedAt: Date.now() - 600_000 }));
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
  });

  it("the SAME run on a copy tab that opened LATER: this tab keeps it, whatever the ids", async () => {
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", otherRun(ts, { sender: "zzzzzzzz-copy-tab", currentIndex: 0, openedAt: Date.now() + 5_000 }));
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(media.state(media.first()!).paused).toBe(false);
  });

  it("the SAME run, no opening times (an older build), the other with the higher id: this tab steps down and goes quiet", async () => {
    // this tab is SOUNDING its first track when it learns the other tab holds the run
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    const ts = await startShowFromUi();
    expect(media.state(media.first()!).paused).toBe(false);

    await act(async () => {
      live().emit("state", otherRun(ts, { sender: "zzzzzzzz-other-tab", currentIndex: 0, sounding: true }));
    });

    // 1. demoted
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    // 2. a viewer is silent: paused and muted
    expect(media.state(media.first()!).muted).toBe(true);
    expect(media.state(media.second()!).muted).toBe(true);
    expect(media.state(media.first()!).paused).toBe(true);
    // 3. and it stopped talking: a viewer that keeps broadcasting is two controllers
    expect(stateSends()).toHaveLength(1);
    expect(screen.queryByTestId("run-conflict")).toBeNull();
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
      live().emit("state", otherRun(ts, { sender: "zzzzzzzz-other-tab", currentIndex: 2 }));
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

  // A page still on the OLD rule ("the newer claim wins", ขอควบคุม) never steps down, and
  // answers every re-assert with its own: at most one re-assert per 2 s per device.
  it("re-asserts at most once per 2 s at a device that will not step down", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    const stubborn = { ...otherRun(ts), controllerSince: null, sender: "old-tab" };
    await act(async () => {
      live().emit("state", { ...stubborn, sentAt: Date.now() });
      live().emit("state", { ...stubborn, sentAt: Date.now() });
      live().emit("state", { ...stubborn, sentAt: Date.now() });
    });
    expect(stateSends()).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      live().emit("state", { ...stubborn, sentAt: Date.now() });
    });
    expect(stateSends()).toHaveLength(3);
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
      live().emit("state", otherRun(ts, { sender: "zzzzzzzz-other-tab", currentIndex: 1 }));
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
// (c2) A VIEWER FOLLOWS A RUN, NOT A DEVICE
//
// The run is the controller's claim stamp: it survives that device's reload (a new
// broadcast id), and a second run on the channel does not pull the screen across.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a viewer follows a run", () => {
  const runState = (run: number, over: Record<string, unknown> = {}) => ({
    sender: "phone",
    sentAt: Date.now(),
    fromController: true,
    begun: true,
    running: true,
    startedAt: run,
    itemStartedAt: run,
    itemElapsedAtPause: null,
    currentIndex: 5,
    mode: "manual",
    controllerSince: run,
    ended: false,
    ...over,
  });
  const index = () => document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index");

  it("keeps watching its run while another run talks on the channel", async () => {
    const { run } = await mountViewer();
    expect(index()).toBe("0");
    await act(async () => {
      live().emit("state", runState(run + 50_000));
    });
    expect(index()).toBe("0");
  });

  it("…and takes the other run up once its own has been silent for a minute", async () => {
    const { run } = await mountViewer();
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    await act(async () => {
      live().emit("state", runState(run + 50_000));
    });
    expect(index()).toBe("5");
  });

  it("follows its run through that device's reload: a new broadcast id, the same claim", async () => {
    const { run } = await mountViewer();
    await act(async () => {
      live().emit("state", runState(run, { sender: "pa-device-after-reload", currentIndex: 4 }));
    });
    expect(index()).toBe("4");
  });

  it("a page that merely opened (no show) moves nothing on a viewer", async () => {
    await mountViewer();
    await act(async () => {
      live().emit("state", {
        sender: "other-page",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "auto",
        controllerSince: null,
        ended: false,
      });
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-begun")).toBe("1");
  });

  it("the reset of some OTHER run does not free a viewer", async () => {
    const { run } = await mountViewer();
    await act(async () => {
      live().emit("state", {
        sender: "phone",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: null,
        ended: false,
        resetRun: run + 50_000,
      });
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
  });

  // The snapshot key is shared by this browser's tabs. A viewer tab that cleared it left
  // the tab running the show with nothing to come back to after a crash.
  it("a viewer leaves the snapshot alone - the one the tab running the show wrote stays", async () => {
    const { run } = await mountViewer();
    const theirs = JSON.stringify({ state: { begun: true }, controllerSince: run, isController: true, savedAt: Date.now() });
    localStorage.setItem(SNAPSHOT_KEY, theirs);
    await act(async () => {
      live().emit("state", runState(run, { sender: "pa-device", currentIndex: 2 }));
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(theirs);
  });

  it("a reset names the run it stops, and drops this device's claim", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    confirm.mockRestore();
    const last = stateSends().at(-1)!.payload;
    expect(last.begun).toBe(false);
    expect(last.resetRun).toBe(ts);
    expect(last.controllerSince).toBeNull();
  });
});

describe("LiveMode · before a show, and after one is reset", () => {
  it("two pages before any show do not make each other viewers: both keep START", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", {
        sender: "other-page",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "auto",
        controllerSince: null,
        ended: false,
      });
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-controller")).toBe("1");
  });

  it("a viewer whose show is RESET by its device is free again: START comes back", async () => {
    const { run } = await mountViewer();
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: null,
        ended: false,
        resetRun: run,
      });
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    // not at once: it asks again whether a show is up, and gives the answer time
    expect(screen.getByTestId("start-show")).toBeDisabled();
    expect(live().lastSent("sync-request")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("start-show")).toBeEnabled();
  });

  it("a fresh page takes nothing from another viewer's reply - not a running show, not an ended one", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", {
        sender: "phone-that-slept-through-a-reset",
        sentAt: Date.now(),
        fromController: false,
        begun: true,
        running: true,
        startedAt: Date.now() - 3600_000,
        itemStartedAt: Date.now() - 60_000,
        itemElapsedAtPause: null,
        currentIndex: 4,
        mode: "manual",
        controllerSince: null,
        run: Date.now() - 3600_000,
        ended: false,
      });
    });
    const root = document.querySelector("[data-cueiq-live]")!;
    expect(root.getAttribute("data-cueiq-live-begun")).toBe("0");
    expect(root.getAttribute("data-cueiq-live-controller")).toBe("1");
  });

  it("…and the ended one is not taken either", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", {
        sender: "some-viewer",
        sentAt: Date.now(),
        fromController: false,
        begun: true,
        running: false,
        startedAt: Date.now() - 3600_000,
        itemStartedAt: null,
        itemElapsedAtPause: 120,
        currentIndex: 5,
        mode: "manual",
        controllerSince: null,
        ended: true,
      });
    });
    const root = document.querySelector("[data-cueiq-live]")!;
    expect(root.getAttribute("data-cueiq-live-begun")).toBe("0");
    expect(root.getAttribute("data-cueiq-live-controller")).toBe("1");
  });
});

describe("LiveMode · the device running the show owns its level and its MAIN record", () => {
  it("ignores another page's volume message while it runs the show", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    const before = media.state(media.first()!).volume;
    await act(async () => {
      live().emit("volume", { sender: "old-tab", itemId: "item-1", target: 0, ms: 0 });
      vi.advanceTimersByTime(300);
    });
    expect(media.state(media.first()!).volume).toBe(before);
  });

  it("claims show_main back when its heartbeat finds the row gone or another device's", async () => {
    await mountLive();
    await startShowFromUi();
    await act(async () => {});
    const claims = () => supa.callsTo("show_authority", "upsert").length;
    const first = claims();
    expect(first).toBeGreaterThan(0);
    // the fake answers the heartbeat's update with no rows: the row is not this device's
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {});
    expect(claims()).toBeGreaterThan(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) SINGLE AUDIO SOURCE — "เสียงออกเครื่องเดียว", the zero-tolerance guarantee
//
// พี่ 2026-10-04: the device that started the show is the only one that sounds it. A
// viewer used to follow the controller's track as a second speaker; now the
// controller's track is never loaded or played on a viewer, and its sound key is
// locked off while the show runs - but its screen follows every cue.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a viewer never sounds", () => {
  it("does not load, seek or play the controller's track - and its sound key is locked off", async () => {
    const media = instrumentMediaElements();
    // the viewer even HOLDS the file: holding it is not a reason to play it
    h.saved = [
      { itemId: "item-2", blob: new Blob(["audio"]), name: "track-2.wav", path: null },
    ];
    await mountLive();

    const anchor = Date.now();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: anchor - 60_000,
        itemStartedAt: anchor,
        itemElapsedAtPause: null,
        currentIndex: 1,
        mode: "manual",
        controllerSince: anchor - 60_000,
        ended: false,
        audioItemId: "item-2",
        audioPlaying: true,
        audioAnchor: anchor,
      });
    });

    // it follows the show on screen…
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index")).toBe("1");
    // …and makes no sound: nothing loaded, nothing played, its output off
    const writes = media.callsFor(media.first()!);
    expect(writes.filter((c) => c.type === "src")).toHaveLength(0);
    expect(writes.filter((c) => c.type === "play")).toHaveLength(0);
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-sound")).toBe("0");
    const key = screen.getByTestId("sound-output-toggle");
    expect(key).toBeDisabled();
    // nor is it asked to "tap to resume" a sound it is never to make
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeNull();
    // the silence is a verdict for this show, not the device's saved preference
    expect(localStorage.getItem("cueiq:soundOutput")).not.toBe("0");
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

    // an operator's NEXT, not the second tap of START (START_SETTLE_MS)
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
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
  // A viewer keeps no snapshot now: it has nothing to resume (it picks the show up from
  // its device again), and one restored as a viewer outlived the show it watched - a
  // page could be left watching nothing, with START gone, forever.
  it("a VIEWER's snapshot (an older build wrote them) is not restored: the page opens fresh", async () => {
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
    const root = document.querySelector("[data-cueiq-live]")!;
    expect(root.getAttribute("data-cueiq-live-begun")).toBe("0");
    expect(root.getAttribute("data-cueiq-live-controller")).toBe("1");
  });

  // Only the device running a show answers for it: a phone that slept through a reset
  // answered for the dead run and made an idle PA its viewer, for good.
  it("a viewer does not answer a sync-request, and writes no snapshot of its own", async () => {
    await mountViewer({}, 1);
    const before = live().sent.length;
    let delivered = 0;
    await act(async () => {
      delivered = live().emit("sync-request", { sender: "joining-phone" });
    });
    // 0 handlers would mean the component never registered — the failure this is hunting.
    expect(delivered).toBe(1);
    expect(live().sent.length).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
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
  // พี่ 2026-10-04: a viewer only watches. No take-over at all - not even a device that
  // turns its own sound on (that is how ขอควบคุม used to appear).
  it("shows the viewer banner, a locked-off sound key, and no ขอควบคุม at all", async () => {
    await mountViewer();
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    const key = screen.getByTestId("sound-output-toggle");
    expect(key).toBeDisabled();
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-sound")).toBe("0");
    await act(async () => {
      fireEvent.click(key);
    });
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-sound")).toBe("0");
    expect(screen.queryByTestId("request-control")).toBeNull();
    expect(screen.queryByText("ขอควบคุม")).toBeNull();
  });

  it("edits nothing: no Loop or file keys on its rows, and the edit chip is gone", async () => {
    await mountViewer();
    expect(screen.queryByTitle(/ไฟล์เพลง/)).toBeNull();
    expect(screen.queryByTitle(/Loop/i)).toBeNull();
    expect(screen.queryByTitle(/แสดงปุ่มแก้ไขของแต่ละแถว/)).toBeNull();
  });

  it("the controller of the same show keeps its edit keys (the lock is the viewer's alone)", async () => {
    seedSnapshot({ isController: true, controllerSince: 1_000 });
    await mountLive();
    expect(screen.queryByTestId("viewer-banner")).toBeNull();
    expect(screen.getAllByTitle(/ไฟล์เพลง/).length).toBeGreaterThan(0);
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
  const LANDSCAPE_PHONE = "[@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]";

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

  it("a viewer is never the sound device, so it is not asked which tracks it holds", async () => {
    const items = [makeItem(1, { audio_path: "t/g/one.mp3" }), makeItem(2), makeItem(3)];
    supa.setTable("setlist_items", ok(items));
    await mountViewer({ items });
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

    it("does not hand its scroll position to the NEXT page when the screen unmounts with the sheet open", async () => {
      // The cleanup that puts the page back runs on UNMOUNT too (the back arrow, a route
      // change). The page that opens next is a new page: restoring Live's 240 there opened
      // it scrolled down. The overflow is given back either way (the test above).
      const { unmount } = await mountLive();
      await act(async () => openTools());
      y = 880; // the page moved while the sheet was open
      unmount();
      expect(document.documentElement.style.overflow).toBe("");
      expect(scrollTo).not.toHaveBeenCalled();
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
    // the tiles alone: 22 + 12 + 62.1 = 96.1 (126.1 with the padding). Neither tile hides on
    // its own — they stand aside together, one row down (CQ-20, the next test)
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

  it("CQ-20: the stage now starts at 600 px, so the SHOW slab's tiles and label step aside too, whole, when IT cannot hold them", async () => {
    // NEXT with six mics and a note is ~293 px and the column is 100vh - 256: at 620 the slab
    // is ~58 px, at 600 ~38, and the tiles were sliced through. The top bar prints the same
    // totals. Each step reads the slab's CONTENT box (its 30 px of padding are outside it).
    await mountLive();
    const slab = screen.getByText("Show", { selector: ".nlabel" }).closest("section") as HTMLElement;
    const stepAside = (el: Element) => {
      const rule = Array.from(el.classList).find((c) => c.includes("container_") && c.includes("max-height") && c.endsWith(":hidden"));
      expect(rule, "the element hides on a container query").toBeDefined();
      expect(rule).not.toContain("@media"); // the slab asks, not the window
      return Number(/max-height:([\d.]+)px/.exec(rule!)![1]);
    };
    const tiles = slab.querySelector(".well")!.parentElement as HTMLElement;
    expect(tiles.querySelectorAll(".well")).toHaveLength(2); // one step for both: never one tile
    const label = slab.querySelector(".nlabel") as HTMLElement;
    const big = slab.querySelector(".items-baseline") as HTMLElement;
    // the tiles need 22 + 12 + 62.1 = 96.1: a few px over, never under, and not far over
    expect(stepAside(tiles)).toBeGreaterThanOrEqual(96.1 + 2);
    expect(stepAside(tiles)).toBeLessThanOrEqual(96.1 + 8);
    // the label is 22 px tall
    expect(stepAside(label)).toBeGreaterThanOrEqual(22 + 2);
    expect(stepAside(label)).toBeLessThanOrEqual(22 + 8);
    // and they go in order: the 50 px copy first, then the tiles, then the label
    expect(stepAside(big)).toBeGreaterThan(stepAside(tiles));
    expect(stepAside(tiles)).toBeGreaterThan(stepAside(label));
  });

  it("under 700 px tall the SHOW slab steps aside whole: an empty 'SHOW' plate read as missing data", async () => {
    // Measured: at 1133x680 (an iPad mini's Safari tab, now a stage) and 1366x620 the slab
    // held only its label. Its totals are in the top bar; the plate goes with them.
    await mountLive();
    const slab = screen.getByText("Show", { selector: ".nlabel" }).closest("section") as HTMLElement;
    expect(slab.className.split(/\s+/)).toContain("stage:[@media(max-height:699.98px)]:hidden");
    expect(slab).toHaveClass("stage:flex"); // still the stage's from 700 px up
  });

  it("CQ-20: the NOW card sheds its volume row first, then its cue note, so a banner never squeezes the numerals out", async () => {
    // The countdown box is what is left of the card after every other row: 265.6 px of rows
    // (Chromium, 1366 x 700: box 164.4 in a 430 px content box). The volume row is 10 + 24 of
    // them, the cue note row 2 + 20, a banner takes 60 from the whole card. 4 px of box at 600
    // with one banner; the rows leave while it still has 68. Live tools carries both.
    await mountLive();
    await startShowFromUi();
    const volume = within(nowCard()).getByTitle(/^ความดังของแทร็คนี้/).parentElement as HTMLElement;
    expect(volume).toHaveClass("stage:flex"); // stage only, as before
    const rule = Array.from(volume.classList).find((c) => c.includes("container_") && c.includes("max-height") && c.endsWith(":hidden"));
    expect(rule, "the volume row hides on a container query").toBeDefined();
    expect(rule).not.toContain("@media");
    const threshold = Number(/max-height:([\d.]+)px/.exec(rule!)![1]);
    const needed = 265.6 + 68;
    expect(threshold).toBeGreaterThanOrEqual(needed);
    expect(threshold).toBeLessThanOrEqual(needed + 2);
    // it goes BEFORE the note row (NowCard's own test pins that one's 265.6 - 34 + 68)
    const note = Array.from(nowCard().children).find((c) => c.classList.contains("h-5"))!;
    const noteRule = Array.from(note.classList).find((c) => c.includes("container_") && c.endsWith(":hidden"))!;
    expect(threshold).toBeGreaterThan(Number(/max-height:([\d.]+)px/.exec(noteRule)![1]));
    // …and the card is the container they ask
    expect(nowCard()).toHaveClass("stage:[container-type:size]");
    // Live tools still carries the level (it is what the row hands over to)
    await act(async () => openTools());
    expect(within(sheet()).getAllByTitle(/^ความดังของแทร็คนี้/).length).toBeGreaterThan(0);
  });

  it("CQ-17: the quick-reorder ▲▼ keys are the stage's: a phone's row has no arrows, an admin's stage edit mode keeps them", async () => {
    // On a phone the two 22 px keys took ~28 px from a title that shares the row with the Loop
    // and file keys, and a thumb on a 22 px key mid-show reorders the running order by accident.
    // A phone reorders in the setlist editor. (jsdom has no CSS: what is pinned is the classes.)
    await mountLive();
    const ups = within(order()).getAllByTitle("เลื่อนขึ้น");
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups) {
      const column = up.parentElement as HTMLElement;
      expect(column).toHaveClass("hidden", "flex-col", "stage:flex");
      // both arrows sit in that one column, so they come and go together
      expect(within(column).getByTitle("เลื่อนลง").parentElement).toBe(column);
      // the keys' own wrapper still shows them on the stage in edit mode only (as before)
      expect(column.parentElement).toHaveClass("stage:hidden", "stage:group-data-[edit=on]/ro:flex");
    }
  });

  it("CQ-21: the dock's key row is as wide as the cards above it, not the 2xl a portrait iPad overshoots", async () => {
    await mountLive();
    const row = screen.getByTestId("start-show").parentElement as HTMLElement;
    expect(row.closest(".dock")).not.toBeNull();
    expect(row).toHaveClass("mx-auto", "max-w-[40rem]", "stage:max-w-none");
    expect(row).not.toHaveClass("max-w-2xl");
    // the landscape phone's root is max-w-none, so its cards never matched the row
    // anyway: it keeps the 2xl it always had (only the portrait iPad moves)
    expect(row).toHaveClass("[@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:max-w-2xl");
    // the cards: the root's 42rem less its 1rem gutters each side = 40rem
    expect(root()).toHaveClass("max-w-2xl", "px-4");
  });

  it("CQ-06: NEXT with no per-song mic slots says the mics come from the Mic Map, never that there are none", async () => {
    await mountLive();
    expect(nextCard()).toHaveTextContent("— ไมค์ตาม Mic Map —");
    expect(nextCard()).not.toHaveTextContent("ไม่มีไมค์ที่ต้องเตรียม");
    // per-song slots are only SWAPS: "the same as before" was wrong the moment NOW had some
    expect(nextCard()).not.toHaveTextContent("ไมค์เหมือนเดิม");
    expect(nextCard()).not.toHaveTextContent("กลับไมค์");
  });

  it("CQ-06: …and when NOW has swaps and NEXT has none, the swapped mics go back to the Mic Map", async () => {
    const items = [
      makeItem(1, { mic_slots: [{ mic: "4", member: "Ploy" }] }),
      makeItem(2),
      makeItem(3),
    ];
    supa.setTable("setlist_items", ok(items));
    await mountLive({ items });
    expect(nextCard()).toHaveTextContent("— กลับไมค์ตาม Mic Map —");
    expect(nextCard()).not.toHaveTextContent("ไมค์เหมือนเดิม");
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
    expect(nextCard()).not.toHaveTextContent("Mic Map");
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

// ─────────────────────────────────────────────────────────────────────────────
// The NOW card's cover. The event bundle leaves cover pictures out (lib/song-columns.ts),
// so Live reads the setlist's covers itself — once, and only "id, cover".
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode — the NOW card's cover", () => {
  const COVER = "data:image/webp;base64,UklGRg==";
  const covered = [makeItem(1, { song_id: "song-1" }), makeItem(2, { song_id: "song-2" }), makeItem(3)];

  beforeEach(() => {
    resetSongCoverCache();
    supa.query.setTable("songs", (call) =>
      call.columns === "id, cover" ? ok([{ id: "song-1", cover: COVER }, { id: "song-2", cover: null }]) : ok([])
    );
  });

  it("shows the song ON NOW's cover in the NOW card, from one read of the setlist's songs", async () => {
    await mountLive({ items: covered });
    await act(async () => {});
    const now = document.querySelector("section[data-zone]") as HTMLElement;
    expect(now.querySelector('[data-testid="now-cover"]')?.getAttribute("src")).toBe(COVER);
    const reads = supa.query.callsTo("songs", "select").filter((c) => c.columns === "id, cover");
    expect(reads).toHaveLength(1);
    const ids = reads[0].filters.find((x) => x.op === "in")?.value as string[];
    expect([...ids].sort()).toEqual(["song-1", "song-2"]); // the ad-hoc row asks nothing
  });

  it("the running order shows each song's cover in its kind square, still named for AT", async () => {
    await mountLive({ items: covered });
    await act(async () => {});
    const tiles = Array.from(document.querySelectorAll<HTMLElement>(".kind"));
    expect(tiles).toHaveLength(3);
    // song-1 has a cover, song-2 has none, row 3 is ad-hoc: the cover replaces the icon only where there is one
    expect(tiles[0].querySelector("img")?.getAttribute("src")).toBe(COVER);
    expect(tiles[0].getAttribute("aria-label")).toBe("SONG");
    expect(tiles[0].className.split(" ")).toContain("kind"); // the same 36 / 22 px square
    expect(tiles[1].querySelector("img")).toBeNull();
    expect(tiles[1].querySelector("svg")).not.toBeNull();
    expect(tiles[2].querySelector("img")).toBeNull();
  });

  it("a song without a cover (or a row with no song) shows no tile", async () => {
    await mountLive({ items: [covered[1], covered[2]] });
    await act(async () => {});
    const now = document.querySelector("section[data-zone]") as HTMLElement;
    expect(within(now).getByRole("heading", { level: 2 })).toHaveTextContent("Track 2");
    expect(now.querySelector('[data-testid="now-cover"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z) STAGE | CONSOLE — a second board, never a second engine
//
// CONSOLE (components/live/console-board.tsx) replaces the board and nothing else:
// the top bar, the status row, the dock and every player are the same nodes. It is
// per device, STAGE by default, and a screen under the stage size never gets it.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · STAGE | CONSOLE", () => {
  const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
  let stageSize = true;
  beforeEach(() => {
    stageSize = true;
    localStorage.removeItem("cueiq:liveView");
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q === STAGE_QUERY && stageSize,
          media: q,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("cueiq:liveView");
  });
  const order = () => screen.queryByRole("heading", { name: "Running Order" });

  it("opens on STAGE; the switch puts CONSOLE in the board's place and keeps the choice on this device", async () => {
    await mountLive();
    expect(screen.queryByTestId("console")).toBeNull();
    expect(order()).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("live-view-console"));
    expect(screen.getByTestId("console")).toBeInTheDocument();
    expect(order()).toBeNull();
    expect(screen.getByTestId("live-view-console")).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("cueiq:liveView")).toBe("console");
    // everything around the board is the same: the sound key, Manual | Auto, START
    expect(screen.getByTestId("sound-output-toggle")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Show mode" })).toBeInTheDocument();
    expect(screen.getByTestId("start-show")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("live-view-stage"));
    expect(screen.queryByTestId("console")).toBeNull();
    expect(order()).toBeInTheDocument();
    expect(localStorage.getItem("cueiq:liveView")).toBe("stage");
  });

  it("around the board nothing is rebuilt: the same top-bar, status-row and dock NODES", async () => {
    await mountLive();
    const sound = screen.getByTestId("sound-output-toggle");
    const start = screen.getByTestId("start-show");
    const mode = screen.getByRole("group", { name: "Show mode" });
    const tools = screen.getByRole("button", { name: "Live tools" });
    fireEvent.click(screen.getByTestId("live-view-console"));
    expect(screen.getByTestId("console")).toBeInTheDocument();
    expect(screen.getByTestId("sound-output-toggle")).toBe(sound);
    expect(screen.getByTestId("start-show")).toBe(start);
    expect(screen.getByRole("group", { name: "Show mode" })).toBe(mode);
    expect(screen.getByRole("button", { name: "Live tools" })).toBe(tools);
  });

  it("CONSOLE's fader and fades drive Live's own volume, for the cued item (the wire says so)", async () => {
    await mountLive();
    await startShowFromUi();
    fireEvent.click(screen.getByTestId("live-view-console"));
    const volumeSends = () => live().sent.filter((s) => s.event === "volume").map((s) => s.payload);
    fireEvent.keyDown(screen.getByTestId("console-fader"), { key: "ArrowDown" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(volumeSends().at(-1)).toMatchObject({ itemId: "item-1", target: 99, ms: 0 });
    expect(screen.getByTestId("console-fader")).toHaveAttribute("aria-valuenow", "99");
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(volumeSends().at(-1)).toMatchObject({ itemId: "item-1", target: 0, ms: 3000 });
  });

  // 2026-10-07 review: CONSOLE's keys kept the old rule after STAGE's moved to fadeKey
  it("CONSOLE's Mute rides the SOUNDING track too: song 2 cued under song 1 - song 1 fades", async () => {
    instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: new Blob(["a"]), name: "track-1.wav", path: null },
      { itemId: "item-2", blob: new Blob(["b"]), name: "track-2.wav", path: null },
    ];
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next")); // cue song 2; song 1 plays on
    });
    fireEvent.click(screen.getByTestId("live-view-console"));
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const sends = live().sent.filter((x) => x.event === "volume").map((x) => x.payload);
    expect(sends.at(-1)).toMatchObject({ itemId: "item-1", target: 0 });
  });

  it("a device that chose CONSOLE opens on it; under the stage size it is STAGE with no switch", async () => {
    localStorage.setItem("cueiq:liveView", "console");
    const first = await mountLive();
    expect(screen.getByTestId("console")).toBeInTheDocument();
    first.unmount();
    stageSize = false;
    await mountLive();
    expect(screen.queryByTestId("console")).toBeNull();
    expect(screen.queryByTestId("live-view-console")).toBeNull();
    expect(order()).toBeInTheDocument();
  });

  it("switching boards mid-show touches no player and sends nothing", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    const calls = media.calls.length;
    const sends = live().sent.length;
    fireEvent.click(screen.getByTestId("live-view-console"));
    fireEvent.click(screen.getByTestId("live-view-stage"));
    fireEvent.click(screen.getByTestId("live-view-console"));
    expect(media.calls.length).toBe(calls);
    expect(live().sent.length).toBe(sends);
    // the show is where it was, and CONSOLE says so
    expect(screen.getByTestId("console-remain")).toHaveTextContent("4:00");
    expect(screen.getByTestId("next")).toBeInTheDocument();
  });

  it("a CONSOLE clip cues its item as the running order's row would (Manual, the controller)", async () => {
    await mountLive();
    await startShowFromUi();
    fireEvent.click(screen.getByTestId("live-view-console"));
    const clips = screen.getAllByTestId("console-clip");
    await act(async () => {
      fireEvent.click(clips[2]);
    });
    expect(stateSends().at(-1)?.payload.currentIndex).toBe(2);
    // Auto: the clips are locked, as the running order is
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    });
    expect(screen.getAllByTestId("console-clip")[0]).toBeDisabled();
  });

  it("Live tools opened from CONSOLE's เปลี่ยน gives focus back to เปลี่ยน, not ⋯", async () => {
    await mountLive();
    fireEvent.click(screen.getByTestId("live-view-console"));
    const change = screen.getByRole("button", { name: "เปลี่ยน" });
    await act(async () => {
      fireEvent.click(change);
    });
    const sheet = screen.getByRole("dialog", { name: "Live tools" });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(sheet).not.toBeVisible();
    expect(document.activeElement).toBe(change);
    // ⋯ still gets its own focus back the next time
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Live tools" }));
    });
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Live tools" }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z2) THE NOW CARD'S WAVEFORM RUNS ON THE ITEM'S CLOCK
//
// A row's length is the plan; the file is the file. An MC row that plays a 5:12 backing
// track in a 2:32 slot hears only the track's first 2:32, so that is what the waveform
// must draw - the whole file squeezed into the slot put its chorus where its intro plays.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the NOW waveform is the file on the item's clock", () => {
  // a file loud for its first half, silent for its second ("_" = full scale, "A" = the floor)
  const PEAKS = "_".repeat(100) + "A".repeat(100);
  const heights = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="now-wave"] > div > span')).map((b) =>
      parseFloat(b.style.height)
    );
  const signal = (duration: number | null) => ({
    "song-1": { lufs: -9, peaks: PEAKS, beatOffset: null, bpm: null, duration },
  });

  it("a file twice the slot: only its first half - the loud half - is drawn", async () => {
    await mountLive({ items: [makeItem(1, { song_id: "song-1", duration_seconds: 120 }), ITEMS[1]], songSignal: signal(240) });
    const h = heights();
    expect(h).toHaveLength(200);
    expect(h.every((x) => x === 100)).toBe(true);
  });

  it("a file as long as the slot: drawn whole, loud then quiet", async () => {
    await mountLive({ items: [makeItem(1, { song_id: "song-1", duration_seconds: 120 }), ITEMS[1]], songSignal: signal(120) });
    const h = heights();
    expect(h.slice(0, 100).every((x) => x === 100)).toBe(true);
    expect(h.slice(100).every((x) => x < 10)).toBe(true);
  });

  it("a file half the slot: a looping row plays it again, a row that does not loop is silent after it", async () => {
    const looped = await mountLive({
      items: [makeItem(1, { song_id: "song-1", duration_seconds: 240, loop_audio: true }), ITEMS[1]],
      songSignal: signal(120),
    });
    // the file's loud half comes back in the slot's third quarter
    expect(heights().slice(100, 150).every((x) => x === 100)).toBe(true);
    looped.unmount();
    await mountLive({ items: [makeItem(1, { song_id: "song-1", duration_seconds: 240 }), ITEMS[1]], songSignal: signal(120) });
    expect(heights().slice(100).every((x) => x < 10)).toBe(true);
  });

  it("a legacy row's positive buffer-before is no delay: the player starts the file at the item's 0:00", async () => {
    // 60 + 240 = a 300 s block; the 240 s file sounds from 0:00, so 0:00-2:00 is its loud half
    await mountLive({
      items: [makeItem(1, { song_id: "song-1", duration_seconds: 240, buffer_before_seconds: 60 }), ITEMS[1]],
      songSignal: signal(240),
    });
    const h = heights();
    expect(h.slice(0, 80).every((x) => x === 100)).toBe(true);
    expect(h.slice(80, 160).every((x) => x < 10)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z3) CONSOLE DRAWS THE SAME FILE ON THE SAME CLOCK
//
// Live hands CONSOLE each item's file length (the song's, not the row's) and its loop flag;
// the clip editor then draws what the NOW card draws.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · CONSOLE's clip is the file on the item's clock", () => {
  const STAGE_QUERY = "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)";
  const PEAKS = "_".repeat(100) + "A".repeat(100); // loud first half, silent second
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("cueiq:liveView");
  });
  // the clip editor's bars, by column: 1 = full scale, 0.03 = the floor
  const levels = () => {
    const d = [...document.querySelectorAll('[data-testid="console-wave"] path')].map((p) => p.getAttribute("d") ?? "").join("");
    const out: number[] = [];
    for (const m of d.matchAll(/M([\d.]+) [-\d.]+h[\d.]+v([\d.]+)/g)) out[Math.floor(Number(m[1]))] = Number(m[2]) / 96;
    return out;
  };
  const signal = (duration: number) => ({ "song-1": { lufs: -9, peaks: PEAKS, beatOffset: null, bpm: null, duration } });

  it("a file twice the slot: the song's length, not the row's - only the loud half is in it", async () => {
    await mountLive({ items: [makeItem(1, { song_id: "song-1", duration_seconds: 120 }), ITEMS[1]], songSignal: signal(240) });
    const l = levels();
    expect(l).toHaveLength(200);
    expect(l.every((x) => x === 1)).toBe(true);
  });

  it("a looping row repeats the file; one that does not loop is silent after it", async () => {
    const looped = await mountLive({
      items: [makeItem(1, { song_id: "song-1", duration_seconds: 240, loop_audio: true }), ITEMS[1]],
      songSignal: signal(120),
    });
    expect(levels().slice(100, 150).every((x) => x === 1)).toBe(true);
    looped.unmount();
    await mountLive({ items: [makeItem(1, { song_id: "song-1", duration_seconds: 240 }), ITEMS[1]], songSignal: signal(120) });
    expect(levels().slice(100).every((x) => x < 0.1)).toBe(true);
  });

  it("a legacy row's positive buffer-before is no delay here either: the file from the clip's 0:00", async () => {
    await mountLive({
      items: [makeItem(1, { song_id: "song-1", duration_seconds: 240, buffer_before_seconds: 60 }), ITEMS[1]],
      songSignal: signal(240),
    });
    const l = levels();
    expect(l.slice(0, 80).every((x) => x === 1)).toBe(true);
    expect(l.slice(80, 160).every((x) => x < 0.1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z4) A LOOPING ROW RESUMES INSIDE ITS FILE
//
// A seek is the item's elapsed time. Past a loop's first pass that is past the file's
// end, where a media element clamps and - looping - starts the file over from 0: a
// resume 3:20 into a 2:00 BGM loop played it from the top. It must land at 1:20.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a looping row resumes inside its file", () => {
  const paused = (elapsed: number) => ({
    state: {
      running: false,
      begun: true,
      startedAt: Date.now() - 400_000,
      itemStartedAt: null,
      itemElapsedAtPause: elapsed,
      currentIndex: 0,
      mode: "manual",
    },
    isController: true,
    controllerSince: 1_000,
  });
  const signal = { "song-1": { lufs: null, peaks: null, beatOffset: null, bpm: null, duration: 120 } };

  it("RUN 3:20 into a 2:00 loop seeks the file to 1:20", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "bgm.wav", path: null }];
    const items = [makeItem(1, { song_id: "song-1", loop_audio: true, duration_seconds: 300 }), makeItem(2)];
    supa.setTable("setlist_items", ok(items));
    seedSnapshot(paused(200));
    await mountLive({ items, songSignal: signal });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    const seeks = media.callsFor(media.first()!).filter((c) => c.type === "currentTime");
    expect(seeks.at(-1)?.value).toBe(80);
  });

  it("a row that does not loop is sought to its elapsed time, as before", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "song.wav", path: null }];
    const items = [makeItem(1, { song_id: "song-1", duration_seconds: 300 }), makeItem(2)];
    supa.setTable("setlist_items", ok(items));
    seedSnapshot(paused(200));
    await mountLive({ items, songSignal: signal });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    const seeks = media.callsFor(media.first()!).filter((c) => c.type === "currentTime");
    expect(seeks.at(-1)?.value).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z5) A SHOW LEFT RUNNING HOURS AGO COMES BACK PAUSED
//
// The snapshot carries the first device's show on after a crash. A rehearsal closed
// while running leaves the same snapshot, and opened again at the venue it came back
// RUNNING - on the desktop app (no autoplay block) a track started out of the PA by
// itself. Gone longer than STALE_RESTORE_MS it comes back paused where it stood.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a show left running long ago comes back paused", () => {
  const runningSnap = (savedAgo: number, intoRow: number) => {
    const savedAt = Date.now() - savedAgo;
    return {
      state: {
        running: true,
        begun: true,
        startedAt: savedAt - 300_000,
        itemStartedAt: savedAt - intoRow * 1000,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "auto",
      },
      committed: { id: "item-1", anchor: savedAt - intoRow * 1000 },
      isController: true,
      controllerSince: savedAt - 300_000,
      savedAt,
    };
  };
  const plays = (media: MediaInstrumentation) => media.calls.filter((c) => c.type === "play").length;

  it("three hours later: paused on the same row, nothing plays until RUN, then from where it stood", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "song.wav", path: null }];
    seedSnapshot(runningSnap(3 * 60 * 60 * 1000, 50));
    await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(plays(media)).toBe(0);
    expect(screen.getByTestId("run-toggle").textContent).not.toContain("Pause");
    // not even the tap-to-resume offer: there is nothing to resume until RUN
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeNull();
    // the snapshot on disk now says paused too
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!);
    expect(snap.state.running).toBe(false);
    expect(snap.committed).toEqual({ id: null, anchor: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    expect(plays(media)).toBeGreaterThan(0);
    const seeks = media.callsFor(media.first()!).filter((c) => c.type === "currentTime");
    expect(seeks.at(-1)?.value).toBe(50);
  });

  it("a minute after a crash: the show carries on running, as before", async () => {
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "song.wav", path: null }];
    seedSnapshot(runningSnap(60_000, 50));
    await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("run-toggle").textContent).toContain("Pause");
    // the sound waits for one tap (no gesture after a reload), at the live position
    expect(screen.getByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeTruthy();
  });

  it("the page tells the viewers where the show is once the reply window has passed", async () => {
    seedSnapshot(runningSnap(3 * 60 * 60 * 1000, 50));
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    // not before a device running a show has had its chance to answer
    expect(stateSends()).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    const sent = stateSends();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.begun).toBe(true);
    expect(sent[0].payload.running).toBe(false);
    expect(sent[0].payload.fromController).toBe(true);
  });

  it("another run answered: no announce - the band's phones stay on the PA's run", async () => {
    seedSnapshot(runningSnap(3 * 60 * 60 * 1000, 50));
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    const t = Date.now();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: t,
        fromController: true,
        begun: true,
        running: true,
        startedAt: t - 600_000,
        itemStartedAt: t - 30_000,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        controllerSince: t - 600_000,
        ended: false,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.getByTestId("run-conflict")).toBeInTheDocument();
    expect(stateSends()).toHaveLength(0);
  });

  it("an answer landing in the same tick the window closes still counts (no render between)", async () => {
    seedSnapshot(runningSnap(3 * 60 * 60 * 1000, 50));
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(1_900);
    });
    const t = Date.now();
    // one act: the PA's answer and the window's end, with no render in between
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: t,
        fromController: true,
        begun: true,
        running: true,
        startedAt: t - 600_000,
        itemStartedAt: t - 30_000,
        itemElapsedAtPause: null,
        currentIndex: 2,
        mode: "manual",
        controllerSince: t - 600_000,
        ended: false,
      });
      vi.advanceTimersByTime(200);
    });
    expect(stateSends()).toHaveLength(0);
  });

  it("a page that restored nothing announces nothing", async () => {
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(stateSends()).toHaveLength(0);
  });

  it("a running show re-writes its snapshot while alive, so its age is the page's", async () => {
    seedSnapshot(runningSnap(60_000, 50));
    await mountLive();
    // past the mount's own writes (the restore, the 500 ms debounce)
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    const before = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!).savedAt;
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    const after = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!).savedAt;
    expect(after - before).toBeGreaterThan(20_000);
    // the page is alive now, so the snapshot is at most one interval old
    expect(Date.now() - after).toBeLessThanOrEqual(30_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z6) A DEVICE THAT CAME LATER SHOWS WHAT THE MASTER PLAYS
//
// พี่ 2026-10-04: the first device is the master; a device that opens later syncs to
// it. Two things a late viewer used to take from ITSELF: the row (by index into its
// own list - one step behind a reorder, it named a different song than the PA) and
// the per-track levels (its own saved ones; the volume messages carry only changes).
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a late viewer follows the master's row and levels", () => {
  const paState = (over: Record<string, unknown> = {}) => {
    const t = Date.now();
    return {
      sender: "pa-device",
      sentAt: t,
      fromController: true,
      begun: true,
      running: true,
      startedAt: t - 60_000,
      itemStartedAt: t - 10_000,
      itemElapsedAtPause: null,
      currentIndex: 0,
      mode: "manual",
      controllerSince: t - 60_000,
      ended: false,
      ...over,
    };
  };
  const index = () => document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index");
  const nowTitle = () =>
    within(document.querySelector("section[data-zone]") as HTMLElement).getByRole("heading", { level: 2 }).textContent;
  const savedLevels = () => JSON.parse(localStorage.getItem(`cueiq:vol:${EVENT_ID}`) ?? "null");

  it("the row is the master's SONG: index 0 on the PA's reordered list is Track 3 here", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", paState({ currentIndex: 0, currentItemId: "item-3" }));
    });
    expect(index()).toBe("2");
    expect(nowTitle()).toContain("Track 3");
  });

  it("without an id (an older build) or with one this list lacks, the index stands", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", paState({ currentIndex: 1 }));
    });
    expect(index()).toBe("1");
    await act(async () => {
      live().emit("state", paState({ currentIndex: 2, currentItemId: "item-new" }));
    });
    expect(index()).toBe("2");
  });

  // พี่ 2026-10-07: shown whole, never saved over this device's own - its soundcheck
  // comes back when it is its own device again (see "this device is itself again").
  it("a viewer SHOWS the master's levels whole - and keeps its own saved ones", async () => {
    localStorage.setItem(`cueiq:vol:${EVENT_ID}`, JSON.stringify({ "item-1": 90, "item-2": 10 }));
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    await act(async () => {
      live().emit("state", paState({ currentItemId: "item-1", volumes: { "item-1": 40, bad: "x" } }));
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getAllByRole("slider").some((s) => (s as HTMLInputElement).value === "40")).toBe(true);
    expect(savedLevels()).toEqual({ "item-1": 90, "item-2": 10 });
  });

  it("a device running its own show keeps its levels whatever another (different) run says", async () => {
    localStorage.setItem(`cueiq:vol:${EVENT_ID}`, JSON.stringify({ "item-1": 70 }));
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", paState({ sender: "phone", controllerSince: ts + 5_000, volumes: { "item-1": 5 } }));
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(savedLevels()).toEqual({ "item-1": 70 });
  });

  it("before any show, another open page's levels change nothing here", async () => {
    localStorage.setItem(`cueiq:vol:${EVENT_ID}`, JSON.stringify({ "item-1": 70 }));
    await mountLive();
    await act(async () => {
      live().emit("state", paState({ sender: "laptop-2", begun: false, running: false, startedAt: null, itemStartedAt: null, controllerSince: null, volumes: { "item-1": 5 } }));
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(savedLevels()).toEqual({ "item-1": 70 });
  });

  it("the two-runs warning says when the other run was STARTED, not its restored clock", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    const rehearsal = ts - 6 * 60 * 60 * 1000;
    await act(async () => {
      live().emit("state", paState({ sender: "phone", controllerSince: rehearsal, startedAt: ts - 600_000 }));
    });
    const warning = screen.getByTestId("run-conflict");
    expect(warning).toHaveTextContent(`เริ่ม ${nowClock(new Date(rehearsal)).slice(0, 5)}`);
  });

  it("the two-runs warning says whether the other run is PLAYING, never which began first", async () => {
    // a rehearsal from this afternoon always "began first" - on the PA that hint pointed
    // the operator at resetting the show itself. The one playing is the show.
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", paState({ sender: "phone", controllerSince: ts - 6 * 60 * 60 * 1000, running: false }));
    });
    const warning = screen.getByTestId("run-conflict");
    expect(warning).toHaveTextContent("เครื่องนั้นหยุดอยู่");
    expect(warning.textContent).not.toContain("เริ่มก่อน");
  });

  it("a viewer joining mid-fade is told the level the fade is going to", async () => {
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^MC$/ })[0]);
    });
    await act(async () => {
      live().emit("sync-request", { sender: "phone-late" });
    });
    expect(stateSends().at(-1)!.payload.volumes["item-1"]).toBe(30);
  });

  it("the PA on a row this list does not have yet: found the moment the list re-reads", async () => {
    await mountLive();
    await act(async () => {
      live().emit("state", paState({ currentIndex: 1, currentItemId: "item-4" }));
    });
    expect(index()).toBe("1"); // not here yet: the index stands
    supa.setTable("setlist_items", ok([makeItem(4, { sort_order: 0 }), ...ITEMS]));
    await act(async () => {
      live().emit("setlist-changed", { sender: "pa-device" });
    });
    await act(async () => {});
    expect(index()).toBe("0");
    expect(nowTitle()).toContain("Track 4");
  });

  it("the device running the show sends its levels with every state", async () => {
    localStorage.setItem(`cueiq:vol:${EVENT_ID}`, JSON.stringify({ "item-1": 55 }));
    await mountLive();
    await startShowFromUi();
    expect(stateSends().at(-1)!.payload.volumes).toEqual({ "item-1": 55 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z7) RESTORE + ANNOUNCE EDGES the reviews named and nothing pinned
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · restore and announce edges", () => {
  const HOURS_3 = 3 * 60 * 60 * 1000;
  const paused = (over: Record<string, unknown> = {}) => ({
    running: false,
    begun: true,
    startedAt: Date.now() - 4 * 60 * 60 * 1000,
    itemStartedAt: null,
    itemElapsedAtPause: 0,
    currentIndex: 0,
    mode: "manual",
    ...over,
  });
  const snapNow = () => JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null");

  it("a tab that yielded to the same run's first tab never re-writes the snapshot after", async () => {
    seedSnapshot({ controllerSince: 1_000 });
    await mountLive();
    await act(async () => {
      live().emit("state", {
        sender: "0000-first-tab",
        sentAt: Date.now(),
        fromController: true,
        ...paused(),
        controllerSince: 1_000,
        openedAt: Date.now() - 600_000,
        ended: false,
      });
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    // what the first tab (the one running the show) has on disk now
    const theirs = JSON.stringify({ state: paused({ currentIndex: 2 }), controllerSince: 1_000, isController: true, savedAt: Date.now() });
    localStorage.setItem(SNAPSHOT_KEY, theirs);
    await act(async () => {
      vi.advanceTimersByTime(65_000); // two of the alive re-writes, had it still been the controller
    });
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(theirs);
  });

  it("a viewer never re-writes the snapshot, however long it watches", async () => {
    const { run } = await mountViewer();
    const theirs = JSON.stringify({ state: { begun: true }, controllerSince: run, isController: true, savedAt: Date.now() });
    localStorage.setItem(SNAPSHOT_KEY, theirs);
    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(theirs);
  });

  it("a show that ENDED, restored hours later: still ended, still paused, clock stopped for the gap", async () => {
    const savedAt = Date.now() - HOURS_3;
    seedSnapshot({ state: paused({ startedAt: savedAt - 3_600_000, itemElapsedAtPause: 200 }), ended: true, savedAt });
    await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("run-toggle").textContent).not.toContain("Pause");
    expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeNull();
    const snap = snapNow();
    expect(snap.ended).toBe(true);
    expect(snap.state.running).toBe(false);
    expect(snap.state.itemElapsedAtPause).toBe(200);
    // the hour that ran before it closed - not four
    expect(Math.round((Date.now() - snap.state.startedAt) / 60_000)).toBe(60);
  });

  describe("a Manual cue (the previous track still sounding, running:false)", () => {
    const cued = (savedAgo: number) => {
      const savedAt = Date.now() - savedAgo;
      return {
        state: paused({ currentIndex: 1, startedAt: savedAt - 600_000 }),
        committed: { id: "item-1", anchor: savedAt - 100_000 },
        savedAt,
      };
    };
    const announced = async () => {
      await act(async () => {
        live().setStatus("SUBSCRIBED");
      });
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      return stateSends().at(-1)?.payload;
    };

    it("hours later: the previous track is dropped - nothing is said to be sounding", async () => {
      seedSnapshot(cued(HOURS_3));
      await mountLive();
      const p = await announced();
      expect(p?.audioItemId).toBe("item-2");
      expect(p?.audioPlaying).toBe(false);
    });

    it("a minute after a crash: the previous track is still the one sounding, as before", async () => {
      seedSnapshot(cued(60_000));
      await mountLive();
      const p = await announced();
      expect(p?.audioItemId).toBe("item-1");
      expect(p?.audioPlaying).toBe(true);
    });
  });

  it("the channel fails inside the reply window: no announce until it is back, then once", async () => {
    seedSnapshot({ state: paused(), savedAt: Date.now() - HOURS_3 });
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      live().setStatus("CHANNEL_ERROR");
    });
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(stateSends()).toHaveLength(0);
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(stateSends()).toHaveLength(1);
  });

  it("the page closes inside the reply window: nothing is sent after", async () => {
    seedSnapshot({ state: paused(), savedAt: Date.now() - HOURS_3 });
    const view = await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    const ch = live();
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(stateSends(ch)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z8) จบโชว์ IS THE MASTER'S ALONE
//
// พี่ 2026-10-04: "มาสเตอร์กดได้เครื่องเดียว". A viewer never had the key. While two runs
// are up nobody can say which device is the master, and the rehearsal's จบโชว์ wrote its
// run time over the real show's last-run record - so both wait for a person to reset
// the one that is not the show; then the master ends it as before.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · only the master ends the show", () => {
  const other = (claim: number, over: Record<string, unknown> = {}) => ({
    sender: "phone",
    sentAt: Date.now(),
    fromController: true,
    begun: true,
    running: false,
    startedAt: claim,
    itemStartedAt: null,
    itemElapsedAtPause: 0,
    currentIndex: 0,
    mode: "manual",
    controllerSince: claim,
    ended: false,
    ...over,
  });
  const lastRunSends = () => live().sent.filter((s) => s.event === "lastrun");

  it("two runs up: the key is locked, says why, and a press records nothing", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", other(ts - 6 * 60 * 60 * 1000));
    });
    const key = screen.getByTestId("end-show") as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(screen.getByTestId("end-show-locked")).toHaveTextContent("เครื่องเปิดเพลงเครื่องเดียว");
    await act(async () => {
      fireEvent.click(key);
    });
    expect(lastRunSends()).toHaveLength(0);
  });

  it("once the other device resets, the master ends the show as before", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    const rehearsal = ts - 6 * 60 * 60 * 1000;
    await act(async () => {
      live().emit("state", other(rehearsal));
    });
    await act(async () => {
      live().emit("state", other(rehearsal, { begun: false, startedAt: null, controllerSince: null, resetRun: rehearsal }));
    });
    expect(screen.queryByTestId("end-show-locked")).toBeNull();
    const key = screen.getByTestId("end-show") as HTMLButtonElement;
    expect(key.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(key);
    });
    expect(lastRunSends()).toHaveLength(1);
  });

  it("a viewer has no จบโชว์ at all", async () => {
    await mountViewer();
    expect(screen.queryByTestId("end-show")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z9) START IS ONE INTENTION
//
// START and NEXT share the dock's centre key: the second tap of a double-tap on START
// landed on NEXT and skipped the first song before anyone heard it; a second Space
// paused the show it had just started. For START_SETTLE_MS (0.8 s) after START, NEXT
// (key, N, →) and Space's pause do nothing - and then they work as before.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · a double-tap on START does not skip the first song", () => {
  const index = () => document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index");
  const runLabel = () => screen.getByTestId("run-toggle").textContent ?? "";

  it("the second tap lands on NEXT and is ignored; a NEXT a second later moves on", async () => {
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(300); // a double-tap's second tap
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    expect(index()).toBe("0");
    expect(stateSends().every((s) => s.payload.currentIndex === 0)).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    expect(index()).toBe("1");
  });

  it("Space, Space: the show starts and keeps running; N right after does not skip", async () => {
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    pressKey(window, { code: "Space", key: " " });
    await act(async () => {});
    expect(runLabel()).toContain("Pause"); // started, running
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    pressKey(window, { code: "Space", key: " " });
    pressKey(window, { key: "n" });
    expect(runLabel()).toContain("Pause"); // still running
    expect(index()).toBe("0");
    // a second later both keys are themselves again
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    pressKey(window, { key: "n" });
    expect(index()).toBe("1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (z10) LIVE KNOWS THE HARD OUT
//
// พี่ 2026-10-04: the band's shows are slots with a Hard Out, and Live projected the end
// without ever knowing it. Now the projected end is read against it - on the show's day,
// once the show runs - and a projection past it says so on every screen.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · the projected end against the Hard Out", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clockIn = (min: number) => {
    const d = new Date(Date.now() + min * 60_000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  };
  // three 4:00 rows → started now, the show ends in 12 minutes
  const props = (hardOutInMin: number, dayOffset = 0) => {
    const day = new Date(Date.now() + dayOffset * 86_400_000);
    return { eventDate: ymd(day), showStartTime: null, hardOutTime: clockIn(hardOutInMin) };
  };

  // (startShowFromUi presses START 2 s after the mount the props were reckoned at)
  it("ends 3 minutes before it: the top bar says so, no warning", async () => {
    await mountLive(props(15));
    await startShowFromUi();
    expect(screen.getByTestId("hard-out-gap").textContent).toBe("ก่อน 2:58");
    expect(screen.queryByTestId("over-hard-out")).toBeNull();
  });

  it("projected 2 minutes past it: the warning, on every screen of the show", async () => {
    await mountLive(props(10));
    await startShowFromUi();
    expect(screen.getByTestId("hard-out-gap").textContent).toBe("เกิน 2:02");
    const banner = screen.getByTestId("over-hard-out");
    expect(banner).toHaveTextContent("เกิน Hard Out");
    expect(banner).toHaveTextContent("2:02");
  });

  it("before START: nothing", async () => {
    await mountLive(props(10));
    expect(screen.queryByTestId("hard-out-gap")).toBeNull();
    expect(screen.queryByTestId("over-hard-out")).toBeNull();
  });

  it("on another day (a rehearsal days before the show): nothing", async () => {
    await mountLive(props(10, 3));
    await startShowFromUi();
    expect(screen.queryByTestId("hard-out-gap")).toBeNull();
    expect(screen.queryByTestId("over-hard-out")).toBeNull();
  });

  it("a viewer of the show sees it too", async () => {
    await mountViewer(props(5));
    expect(screen.getByTestId("over-hard-out")).toBeInTheDocument();
  });

  it("after จบโชว์: gone - there is nothing left to shorten", async () => {
    await mountLive(props(10));
    await startShowFromUi();
    expect(screen.getByTestId("over-hard-out")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    expect(screen.queryByTestId("over-hard-out")).toBeNull();
    expect(screen.queryByTestId("hard-out-gap")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2026-10-07 review) WHAT A PAGE TAKES ON AS A VIEWER, AND A PAUSE THAT COUNTED ON
//
// A viewer is muted - a verdict for the show it watches, never the device's preference.
// The reset that frees the page did not give the sound back: the PA that had watched a
// phone's run-through pressed START for the real show silent (a grey chip, the NO SIGNAL
// watch unmounted).
// And the committed row's anchor kept counting through a pause, so Auto (and a tap back
// on that row) went on ahead of where the show had stopped by the whole pause.
// ─────────────────────────────────────────────────────────────────────────────
describe("LiveMode · after watching another device's run, this device is itself again", () => {
  const VOL_KEY = `cueiq:vol:${EVENT_ID}`;

  it("the reset that frees it gives back its sound and its own levels: its START is heard", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    localStorage.setItem("cueiq:soundOutput", "1");
    // this device's soundcheck: track 1 at 40 %
    localStorage.setItem(VOL_KEY, JSON.stringify({ "item-1": 40 }));

    const { run } = await mountViewer();
    // the phone running the show sends its levels: track 1 at 100 %
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: run,
        itemStartedAt: Date.now() - 10_000,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: run,
        ended: false,
        volumes: { "item-1": 100 },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000); // past the 400 ms save debounce
    });
    expect(media.state(media.first()!).muted).toBe(true);
    expect(JSON.parse(localStorage.getItem(VOL_KEY)!)).toEqual({ "item-1": 40 });

    // the phone resets its run → this page is free
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: null,
        ended: false,
        resetRun: run,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });

    const primary = media.first()!;
    expect(media.state(primary).paused).toBe(false);
    expect(media.state(primary).muted).toBe(false);
    expect(media.state(primary).volume).toBeCloseTo(0.4);
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-sound")).toBe("1");
    expect(localStorage.getItem("cueiq:soundOutput")).toBe("1");
    expect(JSON.parse(localStorage.getItem(VOL_KEY)!)).toEqual({ "item-1": 40 });
  });

  it("an operator who had turned its sound off keeps it off", async () => {
    const media = instrumentMediaElements();
    localStorage.setItem("cueiq:soundOutput", "0");
    const { run } = await mountViewer();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: false,
        running: false,
        startedAt: null,
        itemStartedAt: null,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: null,
        ended: false,
        resetRun: run,
      });
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(media.state(media.first()!).muted).toBe(true);
    expect(localStorage.getItem("cueiq:soundOutput")).toBe("0");
  });
});

describe("LiveMode · a pause stops the clock of the row it stopped", () => {
  it("paused at 0:30 for a minute, Auto goes on at 0:30 - not at 1:30", async () => {
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    const primary = media.first()!;
    expect(media.state(primary).paused).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // pause
    });
    expect(media.state(primary).paused).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });

    const last = stateSends().at(-1)!.payload;
    expect(last.mode).toBe("auto");
    expect(last.running).toBe(true);
    expect(last.currentIndex).toBe(0);
    // the row stands where it was paused: 30 s in, not 90
    expect((Date.now() - (last.itemStartedAt as number)) / 1000).toBeCloseTo(30, 0);
    expect(media.state(primary).currentTime).toBeCloseTo(30, 0);
  });

  it("an MC paused, the next row cued, then a tap back on the MC: still paused where it stopped", async () => {
    const items = [makeItem(1, { kind: "mc", title: "MC", duration_seconds: 59 }), makeItem(2, { kind: "mc", title: "ถ่ายรูป", duration_seconds: 0 })];
    // the refetch on SUBSCRIBED has to answer with these rows, not the three songs
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(items), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    await mountLive({ items });
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // pause the MC at 0:20
    });
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next")); // cue the photo row
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prev")); // back to the MC
    });

    const last = stateSends().at(-1)!.payload;
    expect(last.currentIndex).toBe(0);
    expect(last.running).toBe(false);
    expect(last.itemElapsedAtPause as number).toBeCloseTo(20, 0);
  });
});

// พี่ 2026-10-07: the NOW card's keys (Auto Mute / MC / Auto Loudness) act on the track
// that is SOUNDING, and only for that moment. In Manual they used to fade the cued row
// (nothing heard; a cued song came in silent), and a duck was saved as the song's level -
// a run-through's MC left that song at 30 % for the real show.
describe("LiveMode · the fade keys ride the track that is sounding, for that moment", () => {
  const VOL_KEY = `cueiq:vol:${EVENT_ID}`;
  const volumeSends = () => live().sent.filter((s) => s.event === "volume").map((s) => s.payload);
  const startCueSecond = async () => {
    h.saved = [
      { itemId: "item-1", blob: new Blob(["a"]), name: "track-1.wav", path: null },
      { itemId: "item-2", blob: new Blob(["b"]), name: "track-2.wav", path: null },
    ];
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next")); // cue song 2; song 1 plays on
    });
  };

  it("Manual, song 2 cued under song 1: Auto Mute fades song 1 - not the cued row", async () => {
    const media = instrumentMediaElements();
    await startCueSecond();
    expect(media.state(media.first()!).paused).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Auto Mute/ }));
    });
    expect(volumeSends().at(-1)).toMatchObject({ itemId: "item-1", target: 0 });
  });

  it("the duck is never saved as the song's level", async () => {
    instrumentMediaElements();
    await startCueSecond();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^MC$/ }));
    });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide")); // the flush that saves the levels
    });
    const saved = JSON.parse(localStorage.getItem(VOL_KEY) ?? "{}");
    expect(saved["item-1"] ?? 100).toBe(100);
  });

  it("once song 1 stops sounding, its own level comes back", async () => {
    instrumentMediaElements();
    await startCueSecond();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Auto Mute/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // รันโชว์ on song 2
    });
    await act(async () => {
      vi.advanceTimersByTime(500); // volume messages are spaced 120 ms apart
    });
    expect(volumeSends().at(-1)).toMatchObject({ itemId: "item-1", target: 100 });
  });
});

// พี่ 2026-10-07: a phone that rehearsed in Live this afternoon and was closed mid-run
// comes back paused (STALE_RESTORE_MS) - and used to take the idle PA as a viewer (its
// START gone, its sound off) and hold MAIN so the PA's START was refused. Until someone
// presses play on it, such a HELD run takes no page that was not already watching it.
describe("LiveMode · a run restored paused after a long gap holds nobody until it plays", () => {
  const heldState = (run: number, over: Record<string, unknown> = {}) => ({
    sender: "phone",
    sentAt: Date.now(),
    fromController: true,
    begun: true,
    running: false,
    startedAt: run,
    itemStartedAt: null,
    itemElapsedAtPause: 50,
    currentIndex: 2,
    mode: "auto",
    controllerSince: run,
    ended: false,
    held: true,
    deviceLabel: "iPhone ของมุก",
    ...over,
  });
  const staleSnap = () => {
    const savedAt = Date.now() - 3 * 60 * 60 * 1000;
    return {
      state: {
        running: true,
        begun: true,
        startedAt: savedAt - 300_000,
        itemStartedAt: savedAt - 50_000,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "auto",
      },
      committed: { id: "item-1", anchor: savedAt - 50_000 },
      isController: true,
      controllerSince: savedAt - 300_000,
      savedAt,
    };
  };

  it("an idle PA is not taken as a viewer: it keeps START", async () => {
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      live().emit("state", heldState(Date.now() - 4 * 60 * 60 * 1000));
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("start-show")).toBeEnabled();
  });

  it("an idle page is told about a held run - not about one that has ended", async () => {
    const note = vi.spyOn(toast, "message");
    const told = () => note.mock.calls.filter(([m]) => String(m).includes("มีโชว์ค้างไว้")).length;
    try {
      await mountLive();
      await act(async () => {
        live().setStatus("SUBSCRIBED");
      });
      await act(async () => {
        live().emit("state", heldState(Date.now() - 4 * 60 * 60 * 1000, { ended: true }));
      });
      expect(told()).toBe(0);
      await act(async () => {
        live().emit("state", heldState(Date.now() - 5 * 60 * 60 * 1000)); // another run, not ended
      });
      expect(told()).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByTestId("start-show")).toBeEnabled();
    } finally {
      note.mockRestore();
    }
  });

  it("a running show is not dragged into a two-runs warning by it", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      live().emit("state", heldState(ts - 4 * 60 * 60 * 1000));
    });
    expect(screen.queryByTestId("run-conflict")).not.toBeInTheDocument();
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
  });

  it("a viewer that was watching that run keeps following it", async () => {
    const { run } = await mountViewer();
    await act(async () => {
      live().emit("state", heldState(run, { sender: "pa-device", currentIndex: 2 }));
    });
    expect(document.querySelector("[data-cueiq-live]")!.getAttribute("data-cueiq-live-index")).toBe("2");
  });

  it("the held page says so, claims no MAIN - and does both once it is played", async () => {
    h.saved = [{ itemId: "item-1", blob: new Blob(["audio"]), name: "song.wav", path: null }];
    seedSnapshot(staleSnap());
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(stateSends().at(-1)!.payload.held).toBe(true);
    expect(supa.callsTo("show_authority", "upsert")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // RUN: it is a show again
    });
    expect(stateSends().at(-1)!.payload.held).toBeUndefined();
    expect(supa.callsTo("show_authority", "upsert").length).toBeGreaterThan(0);
  });
});

// 2026-10-08 review: จบโชว์ left MAIN (and its heartbeat) on the device until a reset, so
// a page left open since the afternoon's rehearsal refused the PA's START at night, and an
// idle page that opened became a viewer of a show that was over. Letting go AT จบโชว์ (as
// 723ec35 did) opened the encore gap instead: a phone opening then could start a second
// run. So an ended show holds MAIN for STALE_RESTORE_MS, then lets go. A second จบโชว์
// saved the run plus the time since (the show clock runs on).
describe("LiveMode · an ended show holds nothing, and records its run once", () => {
  const claims = () => supa.callsTo("show_authority", "upsert").length;
  const releases = () => supa.callsTo("show_authority", "delete").length;
  const askState = async () => {
    await act(async () => {
      live().emit("sync-request", { sender: "phone-just-opened" });
    });
    return stateSends().at(-1)!.payload;
  };
  // a heartbeat touches this device's own row (the fake's default ok([]) reads as "the row
  // is gone or another device's" on every beat)
  const ownRowStays = () =>
    supa.setTable("show_authority", (call) => (call.verb === "update" ? ok([{ event_id: EVENT_ID }]) : ok([])));
  beforeEach(() => {
    ownRowStays();
  });

  it("จบโชว์ keeps MAIN through the encore hold, then lets go and takes nobody new", async () => {
    await mountLive();
    await startShowFromUi();
    expect(claims()).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const r0 = releases();
    await act(async () => {
      vi.advanceTimersByTime(9 * 60_000); // the encore gap: still the show
    });
    expect(releases()).toBe(r0);
    let said = await askState();
    expect(said.ended).toBe(true);
    expect(said.held).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(60_000 + 1_000); // the hold is over
    });
    expect(releases()).toBeGreaterThan(r0);
    said = await askState();
    expect(said.held).toBe(true);
    const after = claims();
    await act(async () => {
      vi.advanceTimersByTime(65_000); // two heartbeats' worth: none claims it back
    });
    expect(claims()).toBe(after);
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // played on, long after
    });
    expect(stateSends().at(-1)!.payload.held).toBeUndefined();
    expect(claims()).toBeGreaterThan(after);
  });

  it("a mis-tapped จบโชว์ then play: MAIN is never let go, nothing goes out held", async () => {
    await mountLive();
    await startShowFromUi();
    const r0 = releases();
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    expect(releases()).toBe(r0);
    expect(stateSends().some((s) => s.payload.held === true)).toBe(false);
  });

  // the snapshot of a show that ended an hour in, its page alive until a moment ago
  const endedSnap = () => ({
    state: { running: false, begun: true, startedAt: Date.now() - 3_600_000, itemStartedAt: null, itemElapsedAtPause: 50, currentIndex: 0, mode: "manual" },
    ended: true,
    controllerSince: Date.now() - 3_600_000,
    savedAt: Date.now() - 20_000,
  });

  // the hold lives with the page: reloaded inside it, a page claimed MAIN before it could
  // hear the PA (a phone woken at the venue wrote over the PA's row), and a second tab of
  // the same run, giving way, deleted the first tab's row (one device id per browser)
  it("an ended page that reloads claims no MAIN at all - not even for a moment - and goes out held", async () => {
    seedSnapshot(endedSnap());
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(claims()).toBe(0);
    expect(stateSends().at(-1)!.payload.held).toBe(true);
  });

  it("inside its hold, an ended show whose MAIN another device took while it slept steps aside", async () => {
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const c0 = claims();
    supa.setTable("show_authority", ok([])); // its row is the PA's now
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(claims()).toBe(c0);
    expect((await askState()).held).toBe(true);
  });

  it("inside its hold, an ended show steps aside when another device runs a show", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const r0 = releases();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: true,
        startedAt: Date.now() - 5_000,
        itemStartedAt: Date.now() - 5_000,
        itemElapsedAtPause: null,
        currentIndex: 0,
        mode: "manual",
        controllerSince: ts + 60_000,
        run: ts + 60_000,
        ended: false,
      });
    });
    expect(releases()).toBeGreaterThan(r0);
    expect((await askState()).held).toBe(true);
  });

  it("inside its hold, its own run on another tab does not make it step aside", async () => {
    await mountLive();
    const ts = await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const r0 = releases();
    await act(async () => {
      live().emit("state", {
        sender: "second-tab",
        sentAt: Date.now(),
        fromController: true,
        begun: true,
        running: false,
        startedAt: ts,
        itemStartedAt: null,
        itemElapsedAtPause: 50,
        currentIndex: 0,
        mode: "manual",
        controllerSince: ts,
        run: ts,
        ended: true,
        openedAt: Date.now(), // opened after this page: it is the one that gives way
      });
    });
    expect(releases()).toBe(r0);
    expect((await askState()).held).toBeUndefined();
  });

  it("a heartbeat that answers after a reset claims nothing back", async () => {
    let answer: (() => void) | null = null;
    await mountLive();
    await startShowFromUi();
    // the next beat hangs, then says "not your row"
    supa.setTable("show_authority", (call) =>
      call.verb === "update"
        ? new Promise((resolve) => {
            answer = () => resolve(ok([]));
          })
        : ok([])
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(answer).not.toBeNull();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    confirm.mockRestore();
    const c0 = claims();
    await act(async () => {
      answer!();
    });
    expect(claims()).toBe(c0);
  });


  it("จบโชว์ records the run once - a second press is not possible", async () => {
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    expect(screen.getByTestId("end-show")).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(600_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const writes = supa.callsTo("events", "update").filter((c) => "last_run_seconds" in (c.values as object));
    expect(writes).toHaveLength(1);
  });
});

// 2026-10-07 review: Auto moved on at the next 500 ms tick after a row's end, and the
// next row's clock started from then - ~0.25 s lost per row, never made up (an
// exactly-full slot read "เกิน Hard Out" at the end). It moves on AT the end now.
describe("LiveMode · Auto moves on at the row's end, not at the next tick", () => {
  it("the next row starts within a few ms of the planned end", async () => {
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_250); // START lands between two ticks of the 500 ms clock
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Auto$/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    const ts = stateSends().find((s) => s.payload.begun)!.payload.startedAt as number;
    await act(async () => {
      vi.advanceTimersByTime(240_000 - (Date.now() - ts) + 20); // 20 ms past track 1's end
    });
    const last = stateSends().at(-1)!.payload;
    expect(last.currentIndex).toBe(1);
    expect(last.itemStartedAt as number).toBeLessThanOrEqual(ts + 240_000 + 20);
  });
});

// 2026-10-07 review: two rows with the SAME sort_order (added at once from two devices) -
// ▲▼ swapped the two equal numbers, wrote nothing that changed, told every device the
// setlist changed, and the next read put the rows back. It renumbers the list now.
describe("LiveMode · ▲▼ on two rows with the same sort_order", () => {
  it("renumbers the whole list with the two rows exchanged", async () => {
    const tied = [makeItem(1, { sort_order: 1 }), makeItem(2, { sort_order: 1 }), makeItem(3, { sort_order: 3 })];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(tied), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    await mountLive({ items: tied });
    await act(async () => {
      fireEvent.click(screen.getAllByTitle("เลื่อนขึ้น")[1]); // Track 2 up
    });
    const writes = supa
      .callsTo("setlist_items", "update")
      .map((c) => [(c.eq as Record<string, unknown>).id, (c.values as { sort_order: number }).sort_order]);
    expect(writes).toEqual([
      ["item-2", 1],
      ["item-1", 2],
      ["item-3", 3],
    ]);
  });
});

// 2026-10-07 review of the fixes above: a HELD page that reloads stays held; a duck
// survives a reload; a reset gives a duck back on this device only; a loop BGM's end
// fade does not keep an MC duck as the track's level.
describe("LiveMode · held and ducks across a reload, a reset and a loop's end", () => {
  const VOL_KEY = `cueiq:vol:${EVENT_ID}`;
  const volumeSends = () => live().sent.filter((x) => x.event === "volume").map((x) => x.payload);
  const staleSnap = () => {
    const savedAt = Date.now() - 3 * 60 * 60 * 1000;
    return {
      state: { running: true, begun: true, startedAt: savedAt - 300_000, itemStartedAt: savedAt - 50_000, itemElapsedAtPause: null, currentIndex: 0, mode: "auto" },
      committed: { id: "item-1", anchor: savedAt - 50_000 },
      isController: true,
      controllerSince: savedAt - 300_000,
      savedAt,
    };
  };
  // jsdom draws no frames: each fade lands on its first one, through the fake clock
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now() + 60_000), 16)
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a held page that reloads (its snapshot freshly re-written) is still held", async () => {
    seedSnapshot(staleSnap());
    const first = await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide")); // the snapshot, re-written now
    });
    const written = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!);
    expect(written.held).toBe(true);
    first.unmount();
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(ITEMS), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(stateSends().at(-1)!.payload.held).toBe(true);
    expect(supa.callsTo("show_authority", "upsert")).toHaveLength(0);
  });

  // 2026-10-08: the restore held a show only while it had NOT ended, so จบโชว์ on a held
  // page came back unheld at the next reload - claiming MAIN, taking an idle PA as a viewer.
  it("จบโชว์ on a held page, then a reload: still held, still ended, no MAIN", async () => {
    seedSnapshot(staleSnap());
    const first = await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("end-show"));
    });
    const written = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!);
    expect(written.ended).toBe(true);
    expect(written.held).toBe(true);
    first.unmount();
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(ITEMS), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    const last = stateSends().at(-1)!.payload;
    expect(last.held).toBe(true);
    expect(last.ended).toBe(true);
    expect(supa.callsTo("show_authority", "upsert")).toHaveLength(0);
  });

  it("a rehearsal ended and closed hours ago comes back held - and says it ended", async () => {
    const note = vi.spyOn(toast, "message");
    try {
      const savedAt = Date.now() - 3 * 60 * 60 * 1000;
      seedSnapshot({
        state: { running: false, begun: true, startedAt: savedAt - 300_000, itemStartedAt: null, itemElapsedAtPause: 50, currentIndex: 0, mode: "manual" },
        ended: true,
        controllerSince: savedAt - 300_000,
        savedAt,
      });
      await mountLive();
      await act(async () => {
        live().setStatus("SUBSCRIBED");
      });
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(stateSends().at(-1)!.payload.held).toBe(true);
      expect(supa.callsTo("show_authority", "upsert")).toHaveLength(0);
      const titles = note.mock.calls.map(([m]) => String(m));
      expect(titles).toContain("กู้คืนโชว์ที่จบไปแล้ว");
      expect(titles.some((m) => m.includes("หยุดรอไว้ก่อน") || m === "กู้คืนสถานะโชว์ที่ค้างไว้")).toBe(false);
    } finally {
      note.mockRestore();
    }
  });

  it("a reload mid-MC comes back ducked - and the song's own level is still what is saved", async () => {
    instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["a"]), name: "track-1.wav", path: null }];
    const first = await mountLive();
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^MC$/ }));
    });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!).ducks).toEqual({ "item-1": { prev: 100, now: 30 } });
    first.unmount();
    await mountLive();
    const levels = screen.getAllByTitle(/^ความดังของแทร็คนี้/) as HTMLInputElement[];
    expect(levels.some((l) => l.value === "30")).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(JSON.parse(localStorage.getItem(VOL_KEY) ?? "{}")["item-1"] ?? 100).toBe(100);
  });

  it("the snapshot carries a duck the moment the key is pressed, not at the next cue", async () => {
    instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["a"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^MC$/ }));
    });
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!).ducks).toEqual({ "item-1": { prev: 100, now: 30 } });
  });

  it("a reset during a loop BGM's end fade sends no level to the devices it just freed", async () => {
    const loopItems = [makeItem(1, { loop_audio: true, duration_seconds: 60 }), makeItem(2), makeItem(3)];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(loopItems), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["a"]), name: "bgm.wav", path: null }];
    await mountLive({ items: loopItems });
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(58_000); // into its last 3 s: the end fade is on
    });
    const before = volumeSends().length;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    confirm.mockRestore();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(volumeSends().slice(before)).toEqual([]);
  });

  it("a reset gives a duck back here, and sends no level to the devices it just freed", async () => {
    instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["a"]), name: "track-1.wav", path: null }];
    await mountLive();
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^MC$/ }));
    });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    const before = volumeSends().length;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset"));
    });
    confirm.mockRestore();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(volumeSends().slice(before)).toEqual([]);
  });

  it("an MC on a loop BGM, then its end fade and the next row: the BGM's own level comes back", async () => {
    const loopItems = [makeItem(1, { loop_audio: true, duration_seconds: 60 }), makeItem(2), makeItem(3)];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(loopItems), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: new Blob(["a"]), name: "bgm.wav", path: null },
      { itemId: "item-2", blob: new Blob(["b"]), name: "track-2.wav", path: null },
    ];
    await mountLive({ items: loopItems });
    await startShowFromUi();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^MC$/ })); // BGM under the talking
    });
    await act(async () => {
      vi.advanceTimersByTime(58_000); // into the BGM's last 3 s: its end fade starts
    });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle")); // song 2 on
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      window.dispatchEvent(new Event("pagehide"));
    });
    const lastForBgm = volumeSends().filter((p) => p.itemId === "item-1").at(-1);
    expect(lastForBgm).toMatchObject({ target: 100 });
    expect(JSON.parse(localStorage.getItem(VOL_KEY) ?? "{}")["item-1"] ?? 100).toBe(100);
  });
});

// 2026-10-07: CI caught it in the loop-BGM test above. The volume messages are spaced
// 120 ms apart (real time), and a message held back by that gap kept its timer even
// after a NEWER one went out - landing after it, so a viewer kept a stale level. Also
// one held-back slot for every track: a second track's level dropped the first's.
describe("LiveMode · the volume messages keep their order", () => {
  let clock = 10_000;
  beforeEach(() => {
    clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const volumeSends = () => live().sent.filter((x) => x.event === "volume").map((x) => x.payload);
  const nowLevel = () => screen.getAllByTitle(/^ความดังของแทร็คนี้/)[0] as HTMLInputElement;
  const nextLevel = () => screen.getByTitle(/^ตั้งระดับเสียงของเพลงถัดไปล่วงหน้า/) as HTMLInputElement;

  it("a newer level of the same track is never overtaken by an older one held back", async () => {
    await mountLive();
    await startShowFromUi();
    const before = volumeSends().length;
    fireEvent.change(nowLevel(), { target: { value: "50" } }); // sent at once
    clock += 50;
    fireEvent.change(nowLevel(), { target: { value: "40" } }); // held back by the gap
    clock += 150; // the held one's timer is late - this call comes first
    fireEvent.change(nowLevel(), { target: { value: "20" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const sent = volumeSends().slice(before).map((p) => p.target);
    expect(sent.at(-1)).toBe(20);
    expect(sent).not.toContain(40);
  });

  it("a held-back level of another track still goes out - and before the newer one", async () => {
    await mountLive();
    await startShowFromUi();
    const before = volumeSends().length;
    fireEvent.change(nowLevel(), { target: { value: "50" } }); // track 1, sent at once
    clock += 50;
    fireEvent.change(nextLevel(), { target: { value: "70" } }); // track 2, held back
    clock += 30;
    fireEvent.change(nowLevel(), { target: { value: "45" } }); // track 1 again, held back too
    clock += 150;
    fireEvent.change(nextLevel(), { target: { value: "60" } }); // track 2, at once
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const sent = volumeSends().slice(before).map((p) => `${p.itemId}=${p.target}`);
    expect(sent).toEqual(["item-1=50", "item-1=45", "item-2=60"]);
  });
});
