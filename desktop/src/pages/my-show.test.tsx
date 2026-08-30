// QUICK SHOW (โหมดโชว์เดี่ยว) — the break-glass runner.
//
// Every other screen's fallback link points here, and it is the one screen with
// no server behind it: no login, no event, no Supabase. That means the harness
// is the whole world — a fake clock, a recording store and instrumented audio
// elements — and it also means a defect here has nothing to fall back ON. The
// tests below trace from a real entry point (a click, a clock tick, a relaunch)
// to the behaviour the operator sees, because round 10's most common defect was
// a fix that could not execute and shipped green anyway.
//
// Why the store is a double rather than fake-indexeddb: this project's
// structuredClone does not know jsdom's Blob and flattens it to `{}`, so audio
// bytes cannot survive a real IndexedDB round-trip here (see the harness note in
// desktop/src/lib/solo-store.test.ts, which covers the store against the real
// thing for everything that is not a blob). The double keeps the blobs REAL —
// which is the only way to test the File→Blob boot migration and the rule that a
// dead file reference must never be nulled out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { instrumentMediaElements, type MediaInstrumentation } from "@/test/fakes/supabase";
import type { SoloItem, SoloLastRun } from "~/lib/solo-store";

// ─────────────────────────────────────────────────────────────────────────────
// Doubles
// ─────────────────────────────────────────────────────────────────────────────

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

/** An in-memory stand-in for the on-device store, recording every write. Spelled
 *  out inside vi.hoisted() because vi.mock factories are lifted above every
 *  top-level binding — a shared helper referenced from the factory throws
 *  "Cannot access X before initialization" from inside my-show's own imports. */
const store = vi.hoisted(() => {
  const state = {
    items: [] as SoloItem[],
    lastRun: null as SoloLastRun | null,
    /** every batch handed to putSoloItem/putSoloItems, shallow-copied so the
     *  blob REFERENCE is preserved and a nulled-out one is visible */
    writes: [] as SoloItem[][],
    deleted: [] as string[],
    lastRunWrites: [] as (SoloLastRun | null)[],
    /** set to make the next (and every later) write reject, like a full disk */
    failWrite: null as Error | null,
    write(list: SoloItem[]) {
      if (state.failWrite) throw state.failWrite;
      state.writes.push(list.map((it) => ({ ...it })));
      for (const it of list) {
        const at = state.items.findIndex((x) => x.id === it.id);
        if (at >= 0) state.items[at] = { ...it };
        else state.items.push({ ...it });
      }
    },
    reset() {
      state.items = [];
      state.lastRun = null;
      state.writes = [];
      state.deleted = [];
      state.lastRunWrites = [];
      state.failWrite = null;
    },
  };
  return state;
});

vi.mock("~/lib/solo-store", () => ({
  // fresh copies per read, exactly like getAll() — the boot migration mutates
  // what it is handed, and it must not reach back into "IndexedDB"
  listSoloItems: vi.fn(async () => store.items.map((it) => ({ ...it }))),
  putSoloItem: vi.fn(async (it: SoloItem) => store.write([it])),
  putSoloItems: vi.fn(async (list: SoloItem[]) => store.write(list)),
  deleteSoloItem: vi.fn(async (id: string) => {
    store.deleted.push(id);
    store.items = store.items.filter((it) => it.id !== id);
  }),
  getSoloLastRun: vi.fn(async () => store.lastRun),
  setSoloLastRun: vi.fn(async (rec: SoloLastRun | null) => {
    store.lastRun = rec;
    store.lastRunWrites.push(rec);
  }),
  soloStorageBytes: vi.fn(async () =>
    store.items.reduce((n, it) => n + (it.blob?.size ?? 0), 0)
  ),
}));

import { MyShow } from "./my-show";

// ─────────────────────────────────────────────────────────────────────────────
// The few controls that carry no role-stable English name. Centralised so a Thai
// copy edit breaks one line here instead of a dozen assertions — and so the one
// string class this repo has a documented corruption hazard for appears exactly
// once per control.
// ─────────────────────────────────────────────────────────────────────────────
const TH = {
  moveUp: "เลื่อนขึ้น",
  sourceGone: /ไฟล์ต้นทางหาย/,
  pickNewFile: "เลือกไฟล์ใหม่",
  persistFailed: /บันทึกลงเครื่องไม่สำเร็จ/,
  clearLastRun: "ล้าง",
} as const;

const SNAPSHOT_KEY = "cueiq:solo:live";

// Captured BEFORE the fake clock is installed, so a test can hand the real event
// loop a turn (promise chains inside the boot effect) without letting wall-clock
// time anywhere near the countdown.
const realSetTimeout = globalThis.setTimeout;
const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let nextBlobId = 0;
/** ArrayBuffer-backed, never a File: a File in IndexedDB is a REFERENCE to a path
 *  on disk, which is the whole reason for the boot migration below. */
function audioBlob(bytes = 64): Blob {
  const buf = new ArrayBuffer(bytes);
  new Uint8Array(buf)[0] = ++nextBlobId;
  return new Blob([buf], { type: "audio/mpeg" });
}

function song(title: string, over: Partial<SoloItem> = {}): SoloItem {
  return {
    id: `id-${title}`,
    kind: "song",
    title,
    fileName: `${title}.mp3`,
    blob: audioBlob(),
    durationSeconds: 180,
    bufferAfterSeconds: 0,
    overlapLeadSeconds: 0,
    loop: false,
    volume: 100,
    sortOrder: 1,
    ...over,
  };
}

function mcBreak(title: string, over: Partial<SoloItem> = {}): SoloItem {
  return {
    ...song(title, over),
    kind: "break",
    fileName: null,
    blob: null,
    durationSeconds: 300,
    ...over,
  };
}

/** A legacy record whose source file has been moved or deleted: Chromium keeps
 *  the File as a path reference and arrayBuffer() rejects at read time. */
function deadFile(name: string): File {
  const f = new File([new ArrayBuffer(8)], name, { type: "audio/mpeg" });
  Object.defineProperty(f, "arrayBuffer", {
    configurable: true,
    value: () =>
      Promise.reject(new DOMException("file not found", "NotFoundError")),
  });
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let media: MediaInstrumentation;
let objectUrls: Map<Blob, string>;
let createdFrom: Blob[];
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  store.reset();
  objectUrls = new Map();
  createdFrom = [];
  let n = 0;
  URL.createObjectURL = ((obj: Blob) => {
    createdFrom.push(obj);
    const url = `blob:quick-show/${++n}`;
    objectUrls.set(obj, url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  media = instrumentMediaElements({ autoRestore: false });

  // Only the timers the show itself runs on. requestAnimationFrame and
  // performance stay REAL on purpose: the volume fades ride those, and faking
  // one without the other gives a fade a clock that disagrees with itself.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
});

afterEach(() => {
  vi.useRealTimers();
  media.restore();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  delete window.cueiqNative;
});

/** Hand the real event loop a turn so the boot effect's promise chain finishes,
 *  then let React flush. Nothing here waits on wall-clock time. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await macrotask();
  });
}

/** Advance the show clock. Callers step deliberately: a single big advance
 *  batches every 500 ms tick into ONE render, and a window the show only passes
 *  THROUGH (the เล่นสวน pre-roll) would never be observed. */
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function boot(items: SoloItem[]) {
  store.items = items;
  const view = render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
  return view;
}

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

const urlFor = (it: SoloItem) => objectUrls.get(it.blob as Blob);

// ── queries ───────────────────────────────────────────────────────────────────
/** The big countdown: the <p> immediately after the current item's title. */
const heading = () => screen.getByRole("heading", { level: 2 });
const countdown = () => heading().nextElementSibling?.textContent;
/** "2 / 3" — position within the running order, off the main card. */
const positionLabel = () =>
  heading().previousElementSibling?.lastElementChild?.textContent;

/** The goto button for a setlist row, found by title. The title also appears in
 *  the main card's <h2> and in the "next up" panel, neither of which is a button. */
function rowButton(title: string): HTMLElement {
  const hit = screen
    .getAllByText(title)
    .map((el) => el.closest("button"))
    .find((b): b is HTMLButtonElement => !!b);
  if (!hit) throw new Error(`no setlist row for "${title}"`);
  return hit;
}
const rowFor = (title: string) => rowButton(title).parentElement as HTMLElement;

/* The transport controls carry only Thai labels (รันโชว์ · จบโชว์) or none at all
 * (the icon-only back/reset), so they used to be reached by POSITION: btns[0..3]
 * of NEXT's parent, and "the last button in the controls card" for จบโชว์. That
 * made the selector a hostage of the layout — appending any control after จบโชว์
 * (a ส่งออกเวลา button, a second row of the output picker) silently handed the
 * two ended-persistence tests a DIFFERENT button, and they would have failed as
 * "lastRunWrites is empty", which reads like the persistence fix broke rather
 * than the selector. These names are live-mode.tsx's, spelled identically, so
 * the two ports of the same transport stay readable side by side. */
const startButton = () => screen.getByTestId("start-show");

function transport() {
  return {
    back: screen.getByTestId("prev"),
    run: screen.getByTestId("run-toggle"),
    next: screen.getByTestId("next"),
    reset: screen.getByTestId("reset"),
  };
}

/** จบโชว์ · บันทึกเวลาสะสม — only rendered once the show has begun. */
const endShowButton = () => screen.getByTestId("end-show");

function nativeBridge() {
  const bridge = {
    isElectron: true as const,
    fetchAudio: vi.fn(async () => new ArrayBuffer(0)),
    putAudio: vi.fn(async () => {}),
    pickAudioFile: vi.fn(async () => null),
    // the parameter is spelled out so `.mock.calls` is typed [boolean], not []
    setShowRunning: vi.fn(async (_running: boolean) => {}),
    setUnloadReason: vi.fn(async (_reason: "show" | "unsaved" | null) => {}),
  };
  window.cueiqNative = bridge;
  return bridge;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The clock
// ─────────────────────────────────────────────────────────────────────────────

const OPENING = song("Opening", {
  durationSeconds: 180,
  bufferAfterSeconds: 15,
  sortOrder: 1,
});
const SECOND = song("Second", { durationSeconds: 200, sortOrder: 2 });
const MC = mcBreak("MC Break", { durationSeconds: 300, sortOrder: 3 });
const threeUp = () => [{ ...OPENING }, { ...SECOND }, { ...MC }];

describe("Quick Show — the running order and the clock", () => {
  it("renders every row with its block length in mm:ss", async () => {
    await boot(threeUp());

    // 3:00 + 0:15 of buffer, 3:20, 5:00 — the buffer is part of the SLOT, which
    // is what the countdown counts down.
    expect(within(rowButton("Opening")).getByText("3:15")).toBeInTheDocument();
    expect(within(rowButton("Second")).getByText("3:20")).toBeInTheDocument();
    expect(within(rowButton("MC Break")).getByText("5:00")).toBeInTheDocument();

    expect(heading()).toHaveTextContent("Opening");
    expect(positionLabel()).toBe("1 / 3");
    expect(countdown()).toBe("3:15");
  });

  it("เริ่ม cues item 1: the file is loaded, played, and the countdown runs", async () => {
    await boot(threeUp());
    const primary = media.first() as HTMLMediaElement;

    await click(startButton());

    expect(media.state(primary).src).toBe(urlFor(OPENING));
    expect(media.callsFor(primary).filter((c) => c.type === "play")).toHaveLength(1);
    // duration + buffer, not duration alone
    expect(countdown()).toBe("3:15");

    await tick(30_000);
    expect(countdown()).toBe("2:45");
    // the show has NOT wandered off item 1
    expect(positionLabel()).toBe("1 / 3");
  });

  it("pause freezes the countdown and resume picks it up where it stopped", async () => {
    await boot(threeUp());
    await click(startButton());
    await tick(30_000);

    await click(transport().run); // พัก
    expect(countdown()).toBe("2:45");

    // 60 s of wall clock pass with the show paused — the slot must not move.
    await tick(60_000);
    expect(countdown()).toBe("2:45");

    await click(transport().run); // รันโชว์
    await tick(15_000);
    // 30 s elapsed before the pause + 15 s after = 45 s of a 195 s slot
    expect(countdown()).toBe("2:30");
  });

  it("จบโชว์ writes a plausible last-run record and stops the audio", async () => {
    await boot(threeUp());
    const primary = media.first() as HTMLMediaElement;
    const startedAt = Date.now();

    await click(startButton());
    await tick(90_000);
    await click(endShowButton());
    await settle();

    expect(store.lastRunWrites).toHaveLength(1);
    expect(store.lastRunWrites[0]).toEqual({ seconds: 90, at: startedAt + 90_000 });
    expect(toast.success).toHaveBeenCalledTimes(1);
    // …and rendered back out of the saved record, in the last-run panel (the
    // accumulated-time tile shows 1:30 too, which is why this is scoped)
    const lastRunPanel = screen
      .getByRole("button", { name: TH.clearLastRun })
      .closest(".rounded-xl") as HTMLElement;
    expect(within(lastRunPanel).getByText("1:30")).toBeInTheDocument();
    expect(media.callsFor(primary).filter((c) => c.type === "pause").length).toBeGreaterThan(0);
  });

  it("จบโชว์ stops the sound even between Manual cues", async () => {
    // The pause used to sit inside endShow's `if (state.running)` branch, and
    // Manual deliberately leaves the previous track sounding while the next row is
    // cued (goto's manual branch sets running:false and touches no audio). So the
    // sequence every Manual show actually ends with — START → NEXT → จบโชว์ —
    // saved the run and let the display sleep while the song played on.
    await boot(threeUp());
    const primary = media.first() as HTMLMediaElement;

    await click(startButton());
    expect(media.state(primary).paused).toBe(false);

    await click(transport().next); // cue row 2; Opening keeps sounding, by design
    expect(positionLabel()).toBe("2 / 3");
    expect(media.state(primary).paused).toBe(false);

    await click(endShowButton());

    // both elements: a เล่นสวน pre-roll must not outlive the show either
    expect(media.state(primary).paused).toBe(true);
    expect(media.state(media.second() as HTMLMediaElement).paused).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Crash/resume — the divergence this round fixed
// ─────────────────────────────────────────────────────────────────────────────

describe("Quick Show — restore after a relaunch", () => {
  it("a show that already ended does not re-arm the display blocker", async () => {
    // THE ONE THAT MATTERS. จบโชว์ leaves begun:true on purpose (clock frozen,
    // run recorded — not a reset), and the Electron power-save blocker is gated
    // on `state.begun && !showEnded`. The snapshot used to carry only
    // { state, savedAt }, so a relaunch after จบโชว์ restored begun:true with
    // showEnded:false and held the venue laptop's display awake indefinitely.
    const native = nativeBridge();
    const view = await boot(threeUp());

    await click(startButton());
    await tick(30_000);
    await click(endShowButton());
    await settle();
    await tick(600); // the snapshot write is debounced 500 ms

    const snap = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) as string);
    expect(snap.state.begun).toBe(true);
    expect(snap.ended).toBe(true);

    view.unmount();
    native.setShowRunning.mockClear();

    await boot(threeUp());

    // The show really did come back — otherwise the assertion below would pass
    // for the wrong reason (nothing restored at all).
    expect(screen.queryByTestId("start-show")).not.toBeInTheDocument();
    expect(native.setShowRunning.mock.calls.map((c) => c[0])).not.toContain(true);
    expect(native.setShowRunning).toHaveBeenLastCalledWith(false);
  });

  it("an encore after จบโชว์ brings the display blocker back", async () => {
    // จบโชว์ freezes the clock, it does not reset — pressing รันโชว์ again is how
    // an encore starts. live-mode.tsx un-ends the show on anything that puts it
    // back in motion (apply()); Quick Show used to leave showEnded true, so the
    // encore ran with the venue laptop free to sleep its display, and the
    // snapshot on disk still said the show was over.
    const native = nativeBridge();
    await boot(threeUp());

    await click(startButton());
    await tick(30_000);
    await click(endShowButton());
    await settle();
    expect(native.setShowRunning).toHaveBeenLastCalledWith(false);

    await click(transport().run); // encore
    await tick(600);

    expect(native.setShowRunning).toHaveBeenLastCalledWith(true);
    const snap = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) as string);
    expect(snap.ended).toBe(false);
  });

  it("the snapshot says ended BEFORE the debounce fires — a quit cannot lose it", async () => {
    // The only writer of cueiq:solo:live is a 500 ms debounce whose cleanup
    // clearTimeout()s on unmount, and the exit guard's beforeunload only sets
    // returnValue. So จบโชว์ followed inside that window by a quit, an app kill, a
    // navigation (or a power cut) left ended:false on disk, and the next launch
    // brought a finished show back as a running one with the display blocker
    // re-armed — the exact bug the `ended` field exists to prevent. live-mode.tsx
    // flushes by hand in endShow(); this port never inherited that.
    const native = nativeBridge();
    const view = await boot(threeUp());

    await click(startButton());
    await tick(30_000);
    await click(endShowButton());
    // deliberately NO tick(600) — this is the window the debounce leaves open
    await act(async () => {
      view.unmount();
    });

    const snap = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) as string);
    expect(snap.state.begun).toBe(true);
    expect(snap.state.running).toBe(false); // frozen, not the pre-จบโชว์ state
    expect(snap.ended).toBe(true);

    // …and the relaunch really does come back as a show that is over
    native.setShowRunning.mockClear();
    await boot(threeUp());
    expect(native.setShowRunning.mock.calls.map((c) => c[0])).not.toContain(true);
  });

  it("pagehide flushes a pending snapshot, so a cue is never one behind", async () => {
    // The other half of the ported flush: localStorage.setItem is synchronous and
    // pagehide is delivered where beforeunload is not, so a quit half a second
    // after a cue must not come back on the previous row.
    await boot(threeUp());

    await click(startButton());
    await tick(600); // the START snapshot lands
    await click(transport().next); // …and the write for THIS cue is still pending

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    const snap = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) as string);
    expect(snap.state.currentIndex).toBe(1);
  });

  it("a show still in progress DOES re-arm the blocker on relaunch", async () => {
    // The control: the fix must not simply switch the blocker off for everyone.
    // A machine that force-quit mid-show comes back holding the display awake.
    const native = nativeBridge();
    window.localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        state: {
          running: false, // between Manual cues — begun, not running
          begun: true,
          startedAt: Date.now() - 600_000,
          itemStartedAt: null,
          itemElapsedAtPause: 42,
          currentIndex: 1,
          mode: "manual",
        },
        ended: false,
        savedAt: Date.now() - 60_000,
      })
    );

    await boot(threeUp());

    expect(positionLabel()).toBe("2 / 3");
    expect(native.setShowRunning.mock.calls.map((c) => c[0])).toContain(true);
  });

  it("ignores a snapshot older than the 6-hour window", async () => {
    window.localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        state: { ...({} as object), running: false, begun: true, startedAt: 1, itemStartedAt: null, itemElapsedAtPause: 0, currentIndex: 2, mode: "manual" },
        ended: false,
        savedAt: Date.now() - 7 * 60 * 60 * 1000,
      })
    );

    await boot(threeUp());

    expect(startButton()).toBeInTheDocument();
    expect(positionLabel()).toBe("1 / 3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The store as the page uses it: the boot migration and a failed write
// ─────────────────────────────────────────────────────────────────────────────

describe("Quick Show — legacy File records at boot", () => {
  it("copies a readable File into a self-contained Blob and writes it back", async () => {
    const legacy = song("Legacy", { sortOrder: 1 });
    legacy.blob = new File([new ArrayBuffer(32)], "legacy.mp3", { type: "audio/mpeg" });

    await boot([legacy]);
    await settle(); // persistMigrated is detached from boot on purpose

    const written = store.writes.flat().filter((w) => w.id === legacy.id);
    expect(written).toHaveLength(1);
    expect(written[0].blob).toBeInstanceOf(Blob);
    expect(written[0].blob instanceof File).toBe(false);
    // and the row is playable: it got an object URL off the COPIED bytes
    expect(createdFrom).toHaveLength(1);
    expect(createdFrom[0]).toBe(written[0].blob);
  });

  it("marks an unreadable File broken, gives it no URL, and offers a re-pick", async () => {
    const good = song("Good", { sortOrder: 1 });
    const dead = song("Dead", { sortOrder: 2 });
    const gone = deadFile("dead.mp3");
    dead.blob = gone;

    await boot([good, dead]);

    // no object URL for the dead reference — nothing must try to play it
    expect(createdFrom).toEqual([good.blob]);
    expect(within(rowFor("Dead")).getByText(TH.sourceGone)).toBeInTheDocument();
    expect(
      within(rowFor("Dead")).getByRole("button", { name: TH.pickNewFile })
    ).toBeInTheDocument();
    expect(within(rowFor("Good")).queryByText(TH.sourceGone)).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("a later reorder must NOT null a dead file reference out", async () => {
    // A replugged USB drive or a restored path revives the song at the next
    // boot — but only if the reference is still there. Every write after the
    // failed migration (reorder, edit, volume) has to put the SAME File back.
    const good = song("Good", { sortOrder: 1 });
    const dead = song("Dead", { sortOrder: 2 });
    const gone = deadFile("dead.mp3");
    dead.blob = gone;

    await boot([good, dead]);
    store.writes.length = 0;

    await click(within(rowFor("Dead")).getByTitle(TH.moveUp));
    await settle();

    const rewritten = store.writes.flat().find((w) => w.id === dead.id);
    expect(rewritten?.sortOrder).toBe(1); // the reorder really happened
    expect(rewritten?.blob).toBe(gone);
    expect(store.items.find((it) => it.id === dead.id)?.blob).toBe(gone);
  });
});

describe("Quick Show — a write the machine could not make", () => {
  it("says so instead of letting the edit look saved", async () => {
    await boot(threeUp());
    store.failWrite = new Error("QuotaExceededError");

    await click(within(rowFor("Second")).getByTitle(TH.moveUp));
    await settle();

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(TH.persistFailed),
      expect.objectContaining({ description: "QuotaExceededError" })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Auto mode
// ─────────────────────────────────────────────────────────────────────────────

const A1 = song("Alpha", { durationSeconds: 10, sortOrder: 1 });
const A2 = song("Bravo", { durationSeconds: 20, sortOrder: 2 });
const A3 = mcBreak("Closing MC", { durationSeconds: 300, sortOrder: 3 });

async function bootAuto(items: SoloItem[]) {
  const view = await boot(items);
  await click(screen.getByRole("button", { name: "Auto" }));
  await click(startButton());
  return view;
}

describe("Quick Show — Auto mode", () => {
  it("advances exactly once at the block end, and again at the next one", async () => {
    const [a1, a2, a3] = [{ ...A1 }, { ...A2 }, { ...A3 }];
    await bootAuto([a1, a2, a3]);
    const primary = media.first() as HTMLMediaElement;

    const cueingBravo = () =>
      media.calls.filter((c) => c.type === "src" && c.value === urlFor(a2));

    await tick(10_000); // Alpha's 10 s slot is up

    expect(positionLabel()).toBe("2 / 3");
    expect(media.state(primary).src).toBe(urlFor(a2));
    expect(cueingBravo()).toHaveLength(1);

    // 10 s later the guard ref must still be holding: the countdown for Bravo
    // has 10 s to run, and re-firing here would skip the MC block entirely.
    await tick(10_000);
    expect(positionLabel()).toBe("2 / 3");
    expect(cueingBravo()).toHaveLength(1);

    // …but the guard is per-item, not a latch: Bravo's own slot still ends.
    await tick(10_000);
    expect(positionLabel()).toBe("3 / 3");
    expect(heading()).toHaveTextContent("Closing MC");
  });

  it("stops advancing at the last item instead of running off the end", async () => {
    const [a1, a2] = [{ ...A1 }, { ...A2 }];
    await bootAuto([a1, a2]);

    await tick(10_000);
    expect(positionLabel()).toBe("2 / 2");

    await tick(60_000); // 60 s into Bravo's 20 s slot
    expect(positionLabel()).toBe("2 / 2");
    expect(countdown()).toBe("-0:40"); // over time, still on the last item
  });

  it("เล่นสวน pre-rolls the next song BEFORE the current block ends", async () => {
    const [a1, a2, a3] = [{ ...A1 }, { ...A2, overlapLeadSeconds: 5 }, { ...A3 }];
    await bootAuto([a1, a2, a3]);
    const first = media.first() as HTMLMediaElement;
    const second = media.second() as HTMLMediaElement;
    const playsOn = (el: HTMLMediaElement) =>
      media.callsFor(el).filter((c) => c.type === "play");

    // 6 s into a 10 s slot: 4 s left, inside Bravo's 5 s lead.
    await tick(6_000);

    expect(media.state(second).src).toBe(urlFor(a2));
    expect(playsOn(second)).toHaveLength(1);
    // …while Alpha keeps sounding on the primary and the show has not advanced
    expect(media.state(first).src).toBe(urlFor(a1));
    expect(media.state(first).paused).toBe(false);
    expect(positionLabel()).toBe("1 / 3");

    // Block end: the pre-rolled element is PROMOTED, not restarted.
    await tick(4_000);

    expect(positionLabel()).toBe("2 / 3");
    expect(playsOn(second)).toHaveLength(1);
    expect(media.state(first).paused).toBe(false); // outgoing plays out its tail
    // Bravo has already been sounding for its 5 s lead, so its 20 s slot shows 15
    expect(countdown()).toBe("0:15");
  });

  it("does not pre-roll an item with no lead set", async () => {
    const [a1, a2, a3] = [{ ...A1 }, { ...A2 }, { ...A3 }];
    await bootAuto([a1, a2, a3]);
    const second = media.second() as HTMLMediaElement;

    await tick(6_000);

    expect(media.state(second).src).toBe("");
    expect(media.callsFor(second).filter((c) => c.type === "play")).toHaveLength(0);
  });
});
