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
