import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentType, ReactElement, ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// main.tsx's LAST-RESORT CRASH SCREEN (data-cueiq-screen="app-error").
//
// Without a boundary any render throw leaves a white window mid-show, so main.tsx
// keeps a deliberately dumb one — plain markup, no app components — with two ways
// out: reload, or the fully-local Quick Show. It is also the one screen with no
// router above it, so it cannot use the shared QuickShowLink (a <Link>); it can and
// does wear the same Black Stage as the rest: bg-background, a slab, the page light.
//
// main.tsx renders into #root as it is imported, so the module is imported once with
// createRoot's #root call captured (everything else passes through to the real
// react-dom, which testing-library needs), and the boundary is lifted out of the
// element tree it was handed.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ rendered: null as unknown }));

vi.mock("react-dom/client", async (orig) => {
  const actual = await orig<typeof import("react-dom/client")>();
  const createRoot = ((container: Element, opts?: unknown) =>
    container.id === "root"
      ? { render: (el: unknown) => void (h.rendered = el), unmount: () => {} }
      : actual.createRoot(container, opts as never)) as typeof actual.createRoot;
  return { ...actual, createRoot, default: { ...actual, createRoot } };
});
vi.mock("~/App", () => ({ App: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));
vi.mock("~/data/mgmt-outbox", () => ({
  enqueueMgmtOp: vi.fn(),
  dropPendingAudioUploadOp: vi.fn(),
  pendingAudioSongIds: vi.fn(() => Promise.resolve([])),
}));

let Boundary: ComponentType<{ children: ReactNode }>;

beforeAll(async () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  await import("./main");
  // <StrictMode><AppErrorBoundary>…</AppErrorBoundary></StrictMode>
  const strict = h.rendered as ReactElement<{ children: ReactElement }>;
  Boundary = strict.props.children.type as ComponentType<{ children: ReactNode }>;
  root.remove();
});

function Boom(): never {
  throw new Error("live render exploded");
}

function crash() {
  return render(
    <Boundary>
      <Boom />
    </Boundary>
  );
}

const crashScreen = () => document.querySelector('[data-cueiq-screen="app-error"]') as HTMLElement;

let quiet: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => {
  quiet?.mockRestore();
  quiet = null;
  window.location.hash = "";
});
const silence = () => {
  // React logs the caught error, and jsdom its unimplemented reload; both expected.
  quiet = vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("main.tsx — the last-resort crash screen", () => {
  it("keeps the self-test's marker and both ways out", () => {
    silence();
    crash();
    expect(crashScreen()).not.toBeNull();
    expect(screen.getByRole("button", { name: "โหลดใหม่" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quick Show" })).toBeTruthy();
    expect(screen.getByText("live render exploded")).toBeTruthy();
  });

  it("wears the Black Stage: bg-background, ONE page light first, the message on a slab", () => {
    silence();
    crash();
    const cls = crashScreen().className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["relative", "isolate", "bg-background"]));
    expect(cls).not.toContain("bg-muted/30");
    const lights = document.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    expect(crashScreen().firstElementChild).toBe(lights[0]);
    expect(screen.getByRole("heading", { level: 1 }).closest(".slab")).not.toBeNull();
  });

  it("Quick Show sets the hash first (a crashed tree cannot navigate), then reloads", () => {
    silence();
    crash();
    fireEvent.click(screen.getByRole("button", { name: "Quick Show" }));
    expect(window.location.hash).toBe("#/my-show");
  });

  it("renders its children untouched when nothing throws", () => {
    render(
      <Boundary>
        <p>all well</p>
      </Boundary>
    );
    expect(screen.getByText("all well")).toBeTruthy();
    expect(crashScreen()).toBeNull();
  });
});
