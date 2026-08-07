// Shared setup for every jsdom test project.
//
// jsdom is a DOM, not a browser: it has no layout, no media pipeline, no
// IndexedDB, and no object URLs. Every gap below is one this app actually walks
// into on import or first render, so a missing stub shows up as a cryptic
// "not implemented" thrown from inside a component rather than as a failed
// assertion. Keep this file to POLYFILLS ONLY — anything that fakes app
// behaviour belongs in the test that wants it, or the suite starts proving
// things about the harness instead of the app.
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Every date this app renders is a Bangkok date — lib/time.ts pins "today" to
// Asia/Bangkok precisely because a UTC server was showing yesterday's show time.
// CI runs on UTC and this dev box does not, so without this a date assertion is
// green here and red there (or, worse, the other way round).
process.env.TZ = "Asia/Bangkok";
// A real IndexedDB implementation, because the offline path IS the product: song
// blobs (lib/audio-store), the outboxes, the desktop caches. Without it those
// modules take their "storage unavailable" branch and a test would silently
// assert the fallback instead of the thing it meant to test.
import "fake-indexeddb/auto";

// React Testing Library only auto-cleans when vitest globals are on; this repo
// keeps them off (every test imports describe/it/expect explicitly), so unmount
// here or the next test in the file renders into a document that still holds the
// previous component — including its event listeners and timers.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Not hygiene theatre. Live Mode persists a crash-recovery snapshot at
  // `cueiq:live:<eventId>`, plus per-device sound preferences (`cueiq:soundOutput`,
  // `cueiq:vol:*`, `cueiq:crossfade`, `cueiq:audioSink`), and Quick Show persists
  // `cueiq:solo:live`. A snapshot left behind by one test starts the NEXT test's
  // show already running — the likeliest source of an order-dependent failure that
  // only ever reproduces in CI.
  try {
    window.localStorage.clear();
  } catch {
    /* a test may have replaced storage with a throwing stub; that is its business */
  }
});

// ── layout / observers ────────────────────────────────────────────────────────
// jsdom reports 0 for every measurement and implements neither observer. Components
// that measure (the run-order board, the live transport) construct one at mount.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// Assigned through an index signature, not `window.X`: lib.dom declares both, so
// TypeScript narrows `window` itself to `never` inside an `in`-guard and the
// assignment stops compiling — a compile error in a file whose entire job is to
// patch things lib.dom claims already exist.
const globals = window as unknown as Record<string, unknown>;
globals.ResizeObserver ??= NoopObserver;
globals.IntersectionObserver ??= NoopObserver;
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
if (!Element.prototype.hasPointerCapture) {
  // Radix's Select/Dialog call these on pointer interactions; jsdom has neither,
  // and the throw surfaces as an unrelated-looking act() error.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

// ── media ─────────────────────────────────────────────────────────────────────
// jsdom's HTMLMediaElement throws "Not implemented" from play/pause/load. Live
// Mode calls all three on mount. Resolve instead: a test that cares about
// playback asserts on the calls, and one that doesn't must not crash on them.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  writable: true,
  value: vi.fn(() => Promise.resolve()),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLMediaElement.prototype, "load", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

// ── object URLs ───────────────────────────────────────────────────────────────
// Cached audio reaches an <audio> element as a blob: URL. jsdom defines neither
// side, and the missing revoke is the one that leaks across a long suite.
if (!URL.createObjectURL) {
  let n = 0;
  URL.createObjectURL = () => `blob:cueiq-test/${++n}`;
  URL.revokeObjectURL = () => {};
}

// ── crypto ────────────────────────────────────────────────────────────────────
// Client-generated ids (outbox rows, broadcast payloads) use randomUUID. jsdom's
// crypto stub predates it on some Node lines.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  const nodeCrypto = await import("node:crypto");
  Object.defineProperty(globalThis.crypto ?? (globalThis as { crypto?: Crypto }), "randomUUID", {
    configurable: true,
    value: () => nodeCrypto.randomUUID(),
  });
}
