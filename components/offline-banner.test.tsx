import { describe, it, expect, afterEach } from "vitest";
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
