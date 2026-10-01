// The web error card, on the two screens that have no way out of it.
//
// Live Mode and the live show-caller are immersive: ChromeGate drops the header and
// the tab bar there. Before the redesign the header (nav + bell) sat above this card on
// every route, so an error was always one tap from anywhere. Now the card's reload was
// the only control on screen — and a phone opened cold from the "งานเริ่มแล้ว (Live)"
// push, with no history, had nowhere to go when the reload kept failing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { ErrorCard } from "./error-card";

let quiet: ReturnType<typeof vi.spyOn>;
const onLine = Object.getOwnPropertyDescriptor(window.navigator, "onLine");

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

beforeEach(() => {
  quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  setOnline(true);
});
afterEach(() => {
  quiet.mockRestore();
  cleanup();
  if (onLine) Object.defineProperty(window.navigator, "onLine", onLine);
  else delete (window.navigator as { onLine?: boolean }).onLine;
});

const ERR = Object.assign(new Error("boom"), { digest: "123" });

describe("ErrorCard — the way out on the immersive screens", () => {
  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s: reload stays first, and a full-navigation link goes back to the event page",
    (path) => {
      nav.path = path;
      render(<ErrorCard error={ERR} where="in-app" />);
      const reload = screen.getByRole("button", { name: /โหลดหน้าใหม่/ });
      const back = screen.getByRole("link", { name: "กลับไปหน้างาน" });
      expect(back).toHaveAttribute("href", "/events/e1");
      // A plain <a>, after the reload button — secondary, never in its place.
      expect(back.tagName).toBe("A");
      expect(reload.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  );

  it("the offline variant carries it too", async () => {
    nav.path = "/events/e1/run-order/live";
    setOnline(false);
    render(<ErrorCard error={ERR} where="in-app" />);
    expect(await screen.findByText("ออฟไลน์")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "กลับไปหน้างาน" })).toHaveAttribute(
      "href",
      "/events/e1"
    );
  });

  it.each(["/dashboard", "/events/e1", "/events/e1/run-order", "/events/e1/practice"])(
    "%s (has the header and tab bar): the card is unchanged — reload only",
    (path) => {
      nav.path = path;
      render(<ErrorCard error={ERR} where="in-app" />);
      expect(screen.getByRole("button", { name: /โหลดหน้าใหม่/ })).toBeInTheDocument();
      expect(screen.queryByRole("link")).toBeNull();
    }
  );
});
