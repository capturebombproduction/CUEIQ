import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { act } from "@testing-library/react";
import { Component, type ReactNode } from "react";

// 2026-10-27 desktop hunt — a render crash caught mid-show is told to main.
//
// An error boundary that catches a crash (main.tsx's own, or the shell's around the pages)
// unmounts Live / Quick Show, and their cleanups send main the same "show over" a
// deliberate exit does. Main then let the close from the error screen - the operator's
// way back into the show - run the Windows installer under their relaunch. main.tsx now
// passes React an onCaughtError that says "crashed" over the bridge (main.cjs keeps it;
// its half is pinned in main-show-install-hold.test.ts).
//
// Driven from the real entry point: main.tsx is imported and renders into #root through
// the real react-dom, with App standing in as a page whose own boundary catches a crash.

const h = vi.hoisted(() => ({ rootOptions: null as unknown }));

vi.mock("react-dom/client", async (orig) => {
  const actual = await orig<typeof import("react-dom/client")>();
  const createRoot = ((container: Element, opts?: unknown) => {
    if (container.id === "root") h.rootOptions = opts ?? null;
    return actual.createRoot(container, opts as never);
  }) as typeof actual.createRoot;
  return { ...actual, createRoot, default: { ...actual, createRoot } };
});

/** The shell's page boundary, reduced to what matters here: it catches. */
class PageBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  render() {
    return this.state.crashed ? <p>แอปทำงานผิดพลาด</p> : this.props.children;
  }
}
function Boom(): never {
  throw new Error("live render exploded");
}
vi.mock("~/App", () => ({
  App: () => (
    <PageBoundary>
      <Boom />
    </PageBoundary>
  ),
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));
vi.mock("~/data/mgmt-outbox", () => ({
  enqueueMgmtOp: vi.fn(),
  dropPendingAudioUploadOp: vi.fn(),
  pendingAudioSongIds: vi.fn(() => Promise.resolve([])),
  pendingMgmtOps: vi.fn(() => Promise.resolve([])),
}));

const showCrashed = vi.fn(() => Promise.resolve());
let consoleError: ReturnType<typeof vi.spyOn>;
let root: HTMLDivElement;
// test/setup/dom.ts clears every mock before each test, and the crash happens here, in
// beforeAll - so what it recorded is copied out before then.
let crashedCalls = 0;
let logged: unknown[][] = [];

beforeAll(async () => {
  // React reports the caught error; jsdom has nothing to say about it either way.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  window.cueiqNative = {
    isElectron: true,
    fetchAudio: vi.fn(),
    putAudio: vi.fn(),
    pickAudioFile: vi.fn(),
    setShowRunning: vi.fn(() => Promise.resolve()),
    setUnloadReason: vi.fn(() => Promise.resolve()),
    showCrashed,
  };
  root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  await act(async () => {
    await import("./main");
  });
  crashedCalls = showCrashed.mock.calls.length;
  logged = consoleError.mock.calls.slice();
});

afterAll(() => {
  consoleError.mockRestore();
  delete window.cueiqNative;
  root.remove();
});

describe("main.tsx — a crash an error boundary catches is told to main", () => {
  it("the page boundary caught it, and main heard 'crashed'", () => {
    expect(root.textContent).toContain("แอปทำงานผิดพลาด");
    expect(h.rootOptions).toMatchObject({ onCaughtError: expect.any(Function) });
    expect(crashedCalls).toBeGreaterThan(0);
  });

  it("control: the crash is still reported to the console (React's own report is replaced)", () => {
    const isTheCrash = (a: unknown) => a instanceof Error && a.message === "live render exploded";
    expect(logged.some((args) => args.some(isTheCrash))).toBe(true);
  });
});
