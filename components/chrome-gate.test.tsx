// The two screens that run a show are immersive: no app header, no tab bar, no
// push nudge. Everything else keeps them — including the running-order BUILDER
// and the practice room, which share a prefix with the live screens.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { ChromeGate, immersiveEventId, isImmersivePath } from "./chrome-gate";

// The error cards' way out on the two screens without a header (error-card.tsx,
// error-monitor.tsx): the event the screen belongs to, and nothing anywhere else.
describe("immersiveEventId", () => {
  it.each([
    ["/events/e1/live", "e1"],
    ["/events/e1/live/", "e1"],
    ["/events/e1/run-order/live", "e1"],
    ["/events/e1", null],
    ["/events/e1/run-order", null],
    ["/events/e1/practice", null],
    ["/dashboard", null],
    [null, null],
  ])("%s → %s", (path, id) => {
    expect(immersiveEventId(path)).toBe(id);
  });
});

// The gate unmounts the header — and its install button — on the immersive screens.
// Chrome fires beforeinstallprompt once per document, so the capture must not live
// in the button: loading the gate (mounted on every (app) page) installs it, which
// is what lets a document that OPENS on Live still catch the event.
describe("ChromeGate — the install prompt is caught with no header mounted", () => {
  it("loading the gate alone holds Chrome's install prompt back for the app's own button", () => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("isImmersivePath", () => {
  it.each([
    ["/events/e1/live", true],
    ["/events/e1/live/", true],
    ["/events/e1/run-order/live", true],
    ["/events/e1", false],
    ["/events/e1/run-order", false],
    ["/events/e1/practice", false],
    ["/events/e1/edit", false],
    ["/events/live", false], // an event whose id is "live" is a show page
    ["/dashboard", false],
    ["/live", false],
  ])("%s → %s", (path, immersive) => {
    expect(isImmersivePath(path)).toBe(immersive);
  });
});

describe("ChromeGate", () => {
  it("renders the chrome on an ordinary page and nothing on Live", () => {
    nav.path = "/events/e1";
    const { rerender } = render(
      <ChromeGate>
        <header data-testid="chrome" />
      </ChromeGate>
    );
    expect(screen.getByTestId("chrome")).toBeTruthy();
    nav.path = "/events/e1/live";
    rerender(
      <ChromeGate>
        <header data-testid="chrome" />
      </ChromeGate>
    );
    expect(screen.queryByTestId("chrome")).toBeNull();
  });
});
