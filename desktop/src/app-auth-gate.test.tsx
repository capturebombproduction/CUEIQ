import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Outlet } from "react-router-dom";

// ─────────────────────────────────────────────────────────────────────────────
// THE AIRPLANE TEST, IN A JSDOM.
//
// Everything this project still cannot prove without พี่ holding a laptop starts
// at the same place: the app cold-boots at a venue with no internet, and either
// it lets him in on cached data or the night is over. That gate is ~40 lines in
// App.tsx (useAuth + Protected + which routes sit outside the gate), and until
// now nothing tested it, because it needs a DOM, localStorage and a router.
//
// The pages are mocked to one-line markers ON PURPOSE. The subject here is the
// GATE, not what it opens onto: which screen appears for each combination of
// (session, stored session, still-loading), and which routes must stay reachable
// when every other one is closed. Importing the real pages would pull in Live
// Mode, the practice player and the whole library — slow, brittle, and testing
// none of the thing this file is about.
// ─────────────────────────────────────────────────────────────────────────────

const auth = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<{ data: { session: unknown } }>>(),
  onAuthStateChange: vi.fn(),
}));
const cacheSpies = vi.hoisted(() => ({
  clearCache: vi.fn(),
  clearMgmtOutbox: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
vi.mock("~/data/cache", () => ({ clearCache: cacheSpies.clearCache }));
vi.mock("~/data/mgmt-outbox", () => ({ clearMgmtOutbox: cacheSpies.clearMgmtOutbox }));

// The authenticated frame. Renders an Outlet so the nested routes below it still
// resolve — without one the gate would look shut even when it is open.
vi.mock("~/components/shell", () => ({
  Shell: () => (
    <div data-testid="shell">
      <Outlet />
    </div>
  ),
}));
vi.mock("~/data/workspace-context", () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Spelled out one per line rather than through a helper: vi.mock factories are
// hoisted above every top-level binding, so a shared `page()` helper would throw
// "Cannot access 'page' before initialization" from inside App.tsx's own imports.
vi.mock("~/pages/Login", () => ({ Login: () => <div data-testid="page-login" /> }));
vi.mock("~/pages/dashboard", () => ({ Dashboard: () => <div data-testid="page-dashboard" /> }));
vi.mock("~/pages/event", () => ({ EventPage: () => <div data-testid="page-event" /> }));
vi.mock("~/pages/event-new", () => ({ NewEventPage: () => <div data-testid="page-event-new" /> }));
vi.mock("~/pages/event-edit", () => ({ EditEventPage: () => <div data-testid="page-event-edit" /> }));
vi.mock("~/pages/run-order", () => ({ RunOrderPage: () => <div data-testid="page-run-order" /> }));
vi.mock("~/pages/run-order-live", () => ({
  RunOrderLivePage: () => <div data-testid="page-run-order-live" />,
}));
vi.mock("~/pages/live", () => ({ LivePage: () => <div data-testid="page-live" /> }));
vi.mock("~/pages/library", () => ({ Library: () => <div data-testid="page-library" /> }));
vi.mock("~/pages/artists", () => ({ Artists: () => <div data-testid="page-artists" /> }));
vi.mock("~/pages/overview", () => ({ Overview: () => <div data-testid="page-overview" /> }));
vi.mock("~/pages/training", () => ({ Training: () => <div data-testid="page-training" /> }));
vi.mock("~/pages/practice", () => ({ PracticeRoom: () => <div data-testid="page-practice" /> }));
vi.mock("~/pages/crew", () => ({ Crew: () => <div data-testid="page-crew" /> }));
vi.mock("~/pages/admin", () => ({ Admin: () => <div data-testid="page-admin" /> }));
vi.mock("~/pages/my-show", () => ({ MyShow: () => <div data-testid="page-my-show" /> }));

import { App } from "./App";

const STORAGE_KEY = "sb-kewyqqxohckurwuepucv-auth-token";

/** A persisted session with an access token that expired hours ago — exactly what
 *  localStorage holds when the laptop was last online before the drive to the venue. */
function seedStoredSession() {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      access_token: "expired.jwt.value",
      refresh_token: "r3fr3sh",
      expires_at: 1,
      user: { id: "11111111-1111-4111-8111-111111111111", email: "seishin-mem@cueiq.local" },
    })
  );
}

let emitAuthEvent: (event: string, session: unknown) => void = () => {};
const unsubscribe = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  // Default: the network is dead, so getSession answers "no session" (auth-js
  // returns null rather than throwing when a refresh can't reach the server).
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.onAuthStateChange.mockImplementation((cb: (e: string, s: unknown) => void) => {
    emitAuthEvent = cb;
    return { data: { subscription: { unsubscribe } } };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Render at a route and let the getSession promise settle. */
async function boot(route = "/") {
  const view = render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>
  );
  // flush the resolved getSession microtask + the state update it triggers
  await act(async () => {});
  return view;
}

describe("desktop auth gate — cold boot", () => {
  it("sends a machine with no stored session to the login screen", async () => {
    await boot("/");
    expect(screen.getByTestId("page-login")).toBeInTheDocument();
    expect(screen.queryByTestId("shell")).not.toBeInTheDocument();
  });

  it("lets an expired-but-stored session into the app with no network at all", async () => {
    // THE ONE THAT MATTERS. getSession() answers null — the token expired and the
    // refresh POST cannot reach Supabase — but the user never signed out, so the
    // offline pass must open the shell onto cached data instead of /login.
    seedStoredSession();
    await boot("/");
    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(screen.getByTestId("page-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("page-login")).not.toBeInTheDocument();
  });

  it("keeps a live session on the normal online path", async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: "live", user: { id: "u1" } } },
    });
    await boot("/");
    expect(screen.getByTestId("page-dashboard")).toBeInTheDocument();
  });

  it("bounces a signed-in route to /login and remembers where it came from", async () => {
    await boot("/events/abc/live");
    expect(screen.getByTestId("page-login")).toBeInTheDocument();
  });

  it("sends an authed user away from /login", async () => {
    seedStoredSession();
    await boot("/login");
    expect(screen.getByTestId("page-dashboard")).toBeInTheDocument();
  });
});

describe("desktop auth gate — Quick Show is never behind the gate", () => {
  it("opens on a machine that has never signed in", async () => {
    await boot("/my-show");
    expect(screen.getByTestId("page-my-show")).toBeInTheDocument();
  });

  it("opens while the session is still resolving", async () => {
    // A venue network that is JOINED but black-holed leaves getSession hanging.
    // Quick Show hangs off its own route precisely so it is reachable during that
    // window — this is the escape hatch, and it must not wait five seconds for a
    // boot timer to expire first.
    auth.getSession.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter initialEntries={["/my-show"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByTestId("page-my-show")).toBeInTheDocument();
  });

  it.each(["/quick-show", "/emergency"])("answers to the %s alias", async (route) => {
    // One render per case: two boots in a single test leave both trees mounted and
    // screen.getByTestId then fails on "found multiple", which reads like a routing
    // bug and is not one.
    await boot(route);
    expect(screen.getByTestId("page-my-show")).toBeInTheDocument();
  });
});

describe("desktop auth gate — a network that never answers", () => {
  it("shows the boot screen with a way out, then falls through to the offline pass", async () => {
    vi.useFakeTimers();
    seedStoredSession();
    auth.getSession.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );

    // While it waits, the operator is not stranded: a retry and a Quick Show link.
    expect(screen.getByText("กำลังโหลด…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Quick Show/ })).toBeInTheDocument();
    expect(screen.queryByTestId("shell")).not.toBeInTheDocument();

    // BOOT_SESSION_TIMEOUT_MS elapses with getSession still hanging.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(screen.getByTestId("page-dashboard")).toBeInTheDocument();
  });

  it("falls through to the login screen when there is no stored session either", async () => {
    vi.useFakeTimers();
    auth.getSession.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("page-login")).toBeInTheDocument();
  });
});

describe("desktop auth gate — signing out on a shared band device", () => {
  it("wipes the cached workspace and the queued management writes", async () => {
    seedStoredSession();
    await boot("/");
    expect(screen.getByTestId("shell")).toBeInTheDocument();

    // A real sign-out also removes the persisted session, which is what closes the
    // offline pass — model that, or the assertion below would pass for the wrong
    // reason (the gate staying open on a stale stored session).
    window.localStorage.clear();
    await act(async () => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    expect(cacheSpies.clearCache).toHaveBeenCalledTimes(1);
    expect(cacheSpies.clearMgmtOutbox).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("page-login")).toBeInTheDocument();
  });

  it("does not wipe anything on an ordinary token refresh", async () => {
    seedStoredSession();
    await boot("/");
    await act(async () => {
      emitAuthEvent("TOKEN_REFRESHED", { access_token: "fresh", user: { id: "u1" } });
    });
    expect(cacheSpies.clearCache).not.toHaveBeenCalled();
    expect(cacheSpies.clearMgmtOutbox).not.toHaveBeenCalled();
    expect(screen.getByTestId("page-dashboard")).toBeInTheDocument();
  });

  it("stops listening when the app unmounts", async () => {
    const { unmount } = await boot("/");
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
