// The two screens that run a show are immersive: no app header, no tab bar, no
// push nudge. Everything else keeps them — including the running-order BUILDER
// and the practice room, which share a prefix with the live screens.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { ChromeGate, isImmersivePath } from "./chrome-gate";

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
