import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { OfflineBanner } from "./offline-banner";

// The strip that tells an operator mid-show "you are on cached data now". It is
// three lines of code and it is the app's only app-wide network indicator, so the
// thing worth locking is not the markup — it is that the banner reacts to the
// events the browser actually fires, and that it reads the CURRENT value on mount
// rather than assuming online (a desktop cold boot at a venue mounts already
// offline; an initial-state-only version would show nothing all night).

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  setOnline(true);
});

const TEXT = /ออฟไลน์ — กำลังใช้ข้อมูลและไฟล์เพลงที่บันทึกไว้ในเครื่อง/;

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows on mount when the app cold-boots already offline", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it("appears when the connection drops and clears when it returns", () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();

    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(TEXT)).toBeInTheDocument();

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
  });

  it("stops listening once unmounted", () => {
    setOnline(true);
    const { unmount, container } = render(<OfflineBanner />);
    unmount();
    setOnline(false);
    // No act() wrapper on purpose: after unmount this must not schedule a React
    // update at all. If the listener survived, React logs an update-on-unmounted
    // warning and the detached tree would re-render.
    window.dispatchEvent(new Event("offline"));
    expect(container).toBeEmptyDOMElement();
  });
});

// Redesign v2 (FINAL-SPEC-v2 §F.1): the strip used to be a FIXED bar over the top
// 28px of the screen — on top of the sticky header's back link, bell and install,
// at exactly the moment (offline, at a venue) someone needed them. It is in flow
// now: the app header's own second row, or the top of the page where there is no
// such header. Never both.
describe("OfflineBanner — where the strip sits", () => {
  it("is in flow, never a fixed overlay over the header", () => {
    setOnline(false);
    render(<OfflineBanner />);
    const strip = screen.getByTestId("offline-strip");
    expect(strip.className.split(/\s+/)).not.toContain("fixed");
  });

  it("inside the app header it is the only strip — the root layout's copy stands down", () => {
    setOnline(false);
    render(
      <>
        <OfflineBanner />
        <header>
          <OfflineBanner placement="header" />
        </header>
      </>
    );
    expect(screen.getAllByText(TEXT)).toHaveLength(1);
    expect(screen.getByText(TEXT).closest("header")).not.toBeNull();
  });

  it("the root copy comes back where there is no header (login, immersive Live)", () => {
    setOnline(false);
    const { rerender } = render(
      <>
        <OfflineBanner />
        <header>
          <OfflineBanner placement="header" />
        </header>
      </>
    );
    rerender(<OfflineBanner />);
    expect(screen.getAllByText(TEXT)).toHaveLength(1);
    expect(screen.getByText(TEXT).closest("header")).toBeNull();
  });
});

// In flow INSIDE the sticky header, the strip makes the header taller — and what
// sticks under the header (the Event page's tab row, top = var(--header-h)) has to
// know by how much, or the strip's 28px (two lines on a phone: more) of that row
// slides under the glass, at the venue, offline. A header-hosted strip publishes its
// measured height as --offline-strip-h on the root; with none on screen the property
// is gone (consumers fall back to 0px).
describe("OfflineBanner — the height a bar stuck under the header has to clear", () => {
  const published = () => document.documentElement.style.getPropertyValue("--offline-strip-h");
  let height = 28;
  let rect: { mockRestore: () => void };

  beforeEach(() => {
    height = 28;
    rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ height }) as DOMRect);
  });
  afterEach(() => {
    rect.mockRestore();
    vi.unstubAllGlobals();
  });

  it("in the header, offline: publishes its height — and withdraws it when the network returns", () => {
    setOnline(false);
    render(
      <header>
        <OfflineBanner placement="header" />
      </header>
    );
    expect(published()).toBe("28px");

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(published()).toBe("");
  });

  it("withdraws it when the header itself goes (an immersive screen)", () => {
    setOnline(false);
    const { unmount } = render(
      <header>
        <OfflineBanner placement="header" />
      </header>
    );
    expect(published()).toBe("28px");
    unmount();
    expect(published()).toBe("");
  });

  it("follows the strip when it wraps to a second line", () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    setOnline(false);
    const { unmount } = render(
      <header>
        <OfflineBanner placement="header" />
      </header>
    );
    expect(published()).toBe("28px");
    height = 46; // a 360px phone: the Thai sentence wraps
    act(() => observers.forEach((cb) => cb()));
    expect(published()).toBe("46px");
    unmount();
    expect(published()).toBe("");
  });

  it("the root layout's flow copy publishes nothing — it is not inside a sticky header", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByTestId("offline-strip")).toBeInTheDocument();
    expect(published()).toBe("");
  });
});
