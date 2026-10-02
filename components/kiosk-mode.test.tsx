// The installed-app "Best Performance" fullscreen nudge (KioskMode, mounted on every
// page by the account panel). It is a modal: its scrim swallows the next tap and its
// focus trap eats the Space/N shortcuts — so it must NEVER open over the two screens
// that run a show (Live Mode, the festival's live show-caller). What is pinned here:
//  · on an ordinary page, in an installed app that can go fullscreen, it still opens;
//  · on both immersive screens it does not open — at mount, and when the user leaves
//    fullscreen (the re-nudge) — and leaving the show afterwards does not raise it;
//  · one already open on an ordinary page is hidden once the user is on Live.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { KioskMode } from "./kiosk-mode";

// The dialog title only: the description and the button both say "โหมดเต็มจอ" too, and
// getBy/queryBy throw on more than one match.
const NUDGE = /Best Performance/i;

let fsEl: Element | null = null;

function setFullscreen(on: boolean) {
  fsEl = on ? document.documentElement : null;
  act(() => {
    document.dispatchEvent(new Event("fullscreenchange"));
  });
}

beforeEach(() => {
  nav.path = "/dashboard";
  fsEl = null;
  // An installed app (iOS-style flag is enough for isStandalone()) on a browser that
  // has the Fullscreen API — the only combination the nudge is ever for.
  Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  document.documentElement.requestFullscreen = vi.fn(() => Promise.resolve());
  Object.defineProperty(document, "fullscreenElement", {
    get: () => fsEl,
    configurable: true,
  });
});

afterEach(() => {
  delete (window.navigator as { standalone?: boolean }).standalone;
  delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
});

describe("KioskMode — the Best Performance nudge", () => {
  it("opens on an ordinary page of an installed app that can go fullscreen", () => {
    nav.path = "/dashboard";
    render(<KioskMode button={false} />);
    expect(screen.queryByText(NUDGE)).not.toBeNull();
  });

  it.each(["/events/x/live", "/events/x/run-order/live"])(
    "does not open over %s, where a modal scrim would swallow the next NEXT/START tap",
    (path) => {
      nav.path = path;
      render(<KioskMode button={false} />);
      expect(screen.queryByText(NUDGE)).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  );

  it("does not re-nudge on Live when the user leaves fullscreen", () => {
    nav.path = "/events/x/live";
    render(<KioskMode button={false} />);
    setFullscreen(true);
    setFullscreen(false);
    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it("still re-nudges on an ordinary page when the user leaves fullscreen", () => {
    nav.path = "/dashboard";
    render(<KioskMode button={false} />);
    setFullscreen(true);
    expect(screen.queryByText(NUDGE)).toBeNull(); // hidden once in fullscreen
    setFullscreen(false);
    expect(screen.queryByText(NUDGE)).not.toBeNull();
  });

  it("leaving the show does not pop the nudge up the moment the set ends", () => {
    nav.path = "/events/x/live";
    const { rerender } = render(<KioskMode button={false} />);
    nav.path = "/events/x";
    rerender(<KioskMode button={false} />);
    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it("hides one that is already open when the user goes on to Live", () => {
    nav.path = "/dashboard";
    const { rerender } = render(<KioskMode button={false} />);
    expect(screen.queryByText(NUDGE)).not.toBeNull();
    nav.path = "/events/x/live";
    rerender(<KioskMode button={false} />);
    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it("leaves the plain browser tab alone: no installed app, no nudge", () => {
    delete (window.navigator as { standalone?: boolean }).standalone;
    nav.path = "/dashboard";
    render(<KioskMode button={false} />);
    expect(screen.queryByText(NUDGE)).toBeNull();
  });
});
