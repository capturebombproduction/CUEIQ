import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { saveAudio } from "@/lib/audio-store";
import type { LocalOnlyCandidate, PrefetchTarget } from "@/lib/audio-targets";
import type { ShowSetlistRow } from "@/lib/show-readiness";
import { ShowReadinessCheck } from "./show-readiness-check";

// ─────────────────────────────────────────────────────────────────────────────
// THE LAST CARD ANYONE LOOKS AT BEFORE THE WIFI IS CUT.
//
// Round 10's canonical scar is in this component's prop list: `setlist?` is
// OPTIONAL, the whole "silent row" guard was built behind it, and no caller
// passed it — so `silent` was hard-wired to [] on every real call and a green
// "พร้อมโชว์ออฟไลน์" printed over a track that plays nothing. desktop/src/pages/
// live.tsx passes it today and nothing but a comment protects that.
//
// So this file locks BOTH DIRECTIONS from ONE fixture:
//   • setlist PASSED  → the unaccounted row is named and the bare ready claim is
//                       gone from the headline;
//   • setlist OMITTED → the same device, the same cache, the same targets, and
//                       the bare ready claim is back.
// Either half alone passes whether or not the prop is wired at the call site,
// which is precisely how the no-op shipped green. The PAIR is the trace.
// ─────────────────────────────────────────────────────────────────────────────

// The component touches no network, but every createClient() call site in this
// repo lives inside a body/effect/handler, so one top-of-file mock is the cheap
// guarantee that stays true here.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

/**
 * A COUNTER around the real readiness pass — the only way this file can tell
 * "renders once and settles" from "renders forever", because both look identical
 * in the DOM. Everything else in the module is the genuine implementation: the
 * defect being measured is in the component's hook wiring, not in what the pass
 * returns, and a hand-written fake would answer instantly and hide the cost.
 *
 * Each pass reopens IndexedDB and cursor-walks the event's audio cache, so the
 * count is not a style score — it is the work the operator's device does while
 * they stare at this card.
 */
const passes = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/show-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/show-readiness")>();
  return {
    ...actual,
    getShowReadiness: (...args: Parameters<typeof actual.getShowReadiness>) => {
      passes.n += 1;
      return actual.getShowReadiness(...args);
    },
  };
});

const EVENT_ID = "ev-readiness";

/** The row that IS accounted for: linked to a song with a real online master. */
const READY_TARGET: PrefetchTarget = {
  itemId: "row-playable",
  path: "tenant-a/band-1/opening-abc123.wav",
  name: "opening.wav",
};

/**
 * Hoisted to module scope, not written inline, and NOT left to the component's
 * own `localOnly = []` default — see the note in the report: the default
 * parameter mints a new array on every render, which changes `refresh`'s
 * identity, which re-fires the mount effect, which setStates, forever. Passing
 * one stable empty array keeps these tests measuring the `setlist` prop instead
 * of that loop.
 */
const NO_LOCAL_ONLY: LocalOnlyCandidate[] = [];

/**
 * Two song rows. `row-playable` resolves to READY_TARGET; `row-ghost` lost its
 * library song (setlist_items.song_id is ON DELETE SET NULL — the row and its
 * title survive, only the link is wiped), so BOTH resolvers drop it and only the
 * setlist reconciliation can see it. The titles are ASCII fixture data of our
 * own, not product copy, so asserting on them is safe.
 */
const SETLIST: ShowSetlistRow[] = [
  { id: "row-playable", kind: "song", title: "Opening Number", song_id: "song-1" },
  { id: "row-ghost", kind: "song", title: "Ghost Track", song_id: null },
];

/**
 * The exact claim round 10 shipped over a silent track. Asserted as a literal,
 * in both directions, because this string IS the defect: the headline must never
 * read a bare "ready to run offline" while a song row plays nothing.
 */
const BARE_READY = "พร้อมโชว์ออฟไลน์";

/** jsdom implements no StorageManager, and whether a future one appears would
 *  flip `notPinned` and with it the whole headline. Pin it to "storage locked,
 *  plenty of room" so the only variable in this file is the `setlist` prop. */
function stubStorage() {
  Object.defineProperty(window.navigator, "storage", {
    configurable: true,
    value: {
      persisted: () => Promise.resolve(true),
      estimate: () => Promise.resolve({ usage: 1024, quota: 10 * 1024 * 1024 * 1024 }),
    },
  });
}

beforeEach(async () => {
  stubStorage();
  // A cache record at the target's CURRENT path, so getReadiness counts 1/1 ready
  // and the download half of the verdict is out of the way — otherwise every
  // headline reads "ยังไม่พร้อม" and the silent-row difference is invisible.
  //
  // Stored value note: fake-indexeddb's structured clone flattens a jsdom Blob to
  // a plain object, so a real `new Blob([...])` comes back with no `.size` and
  // lib/audio-store.ts's isSuspectBlob correctly calls it suspect (= stale, not
  // ready). What that reader actually needs is a record carrying real byte size
  // and not being a File, so hand it exactly that. This is a harness limit, not a
  // product behaviour worth encoding — keep the shape honest if audio-store's
  // suspect test grows.
  await saveAudio(
    EVENT_ID,
    READY_TARGET.itemId,
    { size: 4096, type: "audio/wav" } as unknown as Blob,
    READY_TARGET.name,
    READY_TARGET.path
  );
  passes.n = 0; // saveAudio runs before any render; count only what a render costs
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "storage");
});

/**
 * The card renders nothing until the async readiness effect answers, so this is a
 * findBy — no timers, no wall-clock waiting. It comes up COLLAPSED here (auto-open
 * keys on downloads needed / files missing, and this fixture has neither), so the
 * click is what exposes the body rows.
 */
async function expandCard(): Promise<HTMLElement> {
  const toggle = await screen.findByRole("button", { expanded: false });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return toggle;
}

describe("ShowReadinessCheck — a setlist row that plays nothing", () => {
  it("names the unaccounted row and withholds the bare ready claim", async () => {
    render(
      <ShowReadinessCheck
        eventId={EVENT_ID}
        targets={[READY_TARGET]}
        localOnly={NO_LOCAL_ONLY}
        setlist={SETLIST}
      />
    );

    const toggle = await expandCard();

    // The headline still says the show can run, and that is deliberate: a
    // hand-typed row is a supported way to build a setlist and nothing here can
    // tell it from a deleted song. What it must NOT say is the unqualified version.
    expect(toggle.textContent).not.toContain(BARE_READY);

    // …and the body names the row by its own title — the only name a row whose
    // library song was deleted has left.
    expect(screen.getByText("Ghost Track")).toBeInTheDocument();
    // The accounted row is never listed there; that would be the guard crying wolf
    // over a perfectly cached track.
    expect(screen.queryByText("Opening Number")).not.toBeInTheDocument();
  });

  it("falls back to the bare ready claim when setlist is omitted", async () => {
    // Same device, same cache, same targets — ONLY the prop is gone. This is the
    // state round 10 shipped: with `setlist` unwired the ghost row leaves no trace
    // anywhere and the operator is told the show is ready to run offline.
    render(
      <ShowReadinessCheck
        eventId={EVENT_ID}
        targets={[READY_TARGET]}
        localOnly={NO_LOCAL_ONLY}
      />
    );

    const toggle = await expandCard();

    expect(toggle.textContent).toContain(BARE_READY);
    expect(screen.queryByText("Ghost Track")).not.toBeInTheDocument();
  });
});

describe("ShowReadinessCheck — a set whose every song row is silent", () => {
  const ONLY_GHOST: ShowSetlistRow[] = [
    { id: "row-ghost", kind: "song", title: "Ghost Track", song_id: null },
  ];

  it("still renders the card when the silent rows are the only finding", async () => {
    // No targets and no local-only candidates: the shape that used to make the
    // card vanish entirely, so the operator saw no mention of those rows at all —
    // only the absence of a control they may never have noticed was there.
    render(
      <ShowReadinessCheck
        eventId={EVENT_ID}
        targets={[]}
        localOnly={NO_LOCAL_ONLY}
        setlist={ONLY_GHOST}
      />
    );

    await expandCard();
    expect(screen.getByText("Ghost Track")).toBeInTheDocument();
  });

  it("renders nothing at all for that same set once setlist is omitted", async () => {
    const { container } = render(
      <ShowReadinessCheck eventId={EVENT_ID} targets={[]} localOnly={NO_LOCAL_ONLY} />
    );
    // Flush the readiness promise so the (still null-rendering) state update lands
    // inside act() rather than after the test has finished.
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CARD MUST NOT SPIN.
//
// Round 10's defect class was "a fix that could not execute". This is that class
// INVERTED: the code executes, over and over, and correctness depends on an
// OPTIONAL prop nobody is required to pass. Omit `localOnly` and the `= []`
// default mints a new array per render → `refresh`'s useCallback identity changes
// per render → the mount effect's [refresh] dep re-fires per render → refresh()
// resolves and setR's a fresh object → render. Measured before the fix: 219 full
// readiness passes in 300ms with the prop omitted, versus exactly 1 with a stable
// array passed, plus React's "Maximum update depth exceeded".
//
// Nothing in the DOM distinguishes the two. Only the counter does — which is why
// a test that merely renders and asserts on text proves nothing here, and why
// these assertions are on `passes.n` and not on pixels.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A component that has settled does the same amount of work whether you flush
 * once or fifty times; one that re-arms its own effect every render keeps
 * counting. So: flush, repeatedly and deterministically, and let the COUNT be the
 * verdict. Each round drains the microtask queue inside act(), which is exactly
 * what lets a pending readiness promise resolve, its setState commit, effects run,
 * and the next pass start. No timers and no wall-clock waiting — the loop, if
 * there is one, is entirely microtask-driven and needs nothing but a yield.
 */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {});
  }
}

/**
 * The ceiling, not the expected value: every arm below measures exactly 1 today,
 * including the one that re-renders its parent ten times. The slack absorbs an
 * honest extra pass (a second effect landing, a dependency legitimately changing
 * once) without absorbing a regression — the unfixed component scored 22, 23 and
 * 11 on these same three arms, so the gap this has to detect is an order of
 * magnitude wide and the ceiling can afford to be forgiving.
 */
const BOUNDED = 4;

describe("ShowReadinessCheck — the preflight must settle, not spin", () => {
  it("runs the readiness pass a bounded number of times with a stable localOnly", async () => {
    // The control arm. Everything the loop arm has, except the prop is passed.
    render(
      <ShowReadinessCheck
        eventId={EVENT_ID}
        targets={[READY_TARGET]}
        localOnly={NO_LOCAL_ONLY}
        setlist={SETLIST}
      />
    );
    await screen.findByRole("button");
    await settle();
    expect(passes.n).toBeLessThanOrEqual(BOUNDED);
  });

  it("runs the readiness pass a bounded number of times when localOnly is OMITTED", async () => {
    // Identical to the control except for the one thing the type system calls
    // optional. `localOnly` is exactly the prop a caller is most likely to leave
    // off — a set with no master-less songs has nothing to put in it.
    render(<ShowReadinessCheck eventId={EVENT_ID} targets={[READY_TARGET]} setlist={SETLIST} />);
    await screen.findByRole("button");
    await settle();
    expect(passes.n).toBeLessThanOrEqual(BOUNDED);
  });

  it("runs the readiness pass a bounded number of times with BOTH optional props omitted", async () => {
    render(<ShowReadinessCheck eventId={EVENT_ID} targets={[READY_TARGET]} />);
    await screen.findByRole("button");
    await settle();
    expect(passes.n).toBeLessThanOrEqual(BOUNDED);
  });

  it("does not restart the pass when a parent re-renders with fresh inline props", async () => {
    // The same hazard from the other end, and the one a FUTURE caller walks into:
    // the props are passed, but as inline literals from a parent that re-renders.
    // desktop/src/pages/live.tsx builds `targets` and `localOnly` in its render
    // body today and only gets away with it because that page re-renders rarely.
    // Equal content must mean an equal dependency; array identity must not.
    function Parent() {
      const [n, setN] = useState(0);
      return (
        <div>
          {/* Rendered, not just held: this is the proof the parent really did
              re-render. Without it a broken bump button would make the whole
              test pass by never exercising anything. */}
          <span data-testid="parent-renders">{n}</span>
          <button type="button" onClick={() => setN((v) => v + 1)}>
            bump parent
          </button>
          <ShowReadinessCheck
            eventId={EVENT_ID}
            targets={[{ ...READY_TARGET }]}
            localOnly={[]}
            setlist={SETLIST.map((row) => ({ ...row }))}
          />
        </div>
      );
    }

    render(<Parent />);
    await screen.findByRole("button", { name: /ตรวจความพร้อม/ });
    await settle();
    const afterMount = passes.n;
    expect(afterMount).toBeLessThanOrEqual(BOUNDED);

    // Ten parent re-renders, each handing down brand-new arrays with identical
    // contents — a parent with a clock, a progress bar or a realtime subscription
    // does this all evening. Every re-render reopening IndexedDB and cursor-walking
    // the audio cache is the same waste as the loop, just clocked by the parent
    // instead of by itself, so the same ceiling applies: equal content, no re-run.
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByRole("button", { name: "bump parent" }));
      await settle();
    }
    expect(screen.getByTestId("parent-renders")).toHaveTextContent("10");
    expect(passes.n).toBeLessThanOrEqual(BOUNDED);
  });
});
