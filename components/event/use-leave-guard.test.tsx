import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { isGuardedNavigation, useLeaveGuard } from "@/components/event/use-leave-guard";
import {
  markPending,
  markSettled,
  resetDirtyGuard,
  hasUnsavedWork,
} from "@/lib/dirty-guard";

// The other half of the 2026-08-13 request: "เวลาที่มีการแก้ไข แล้วจะเปลี่ยนหน้าไป
// หน้าอื่น อยากให้มีการเตือนว่า ยังไม่ได้บันทึก". Round 13 shipped the badge and
// missed this.

function Harness({ enabled = true }: { enabled?: boolean }) {
  useLeaveGuard(enabled);
  return (
    <div>
      <a href="/dashboard" data-testid="in-app">
        กลับหน้าหลัก
      </a>
      <a href="https://maps.example/x" target="_blank" rel="noreferrer" data-testid="map">
        View Map
      </a>
      <a href="#setlist" data-testid="tab-hash">
        เซ็ตลิสต์
      </a>
      <input data-testid="field" />
    </div>
  );
}

/**
 * Dispatch a real click and report whether the guard cancelled it.
 *
 * The probe listener is registered on `document` in the CAPTURE phase AFTER the
 * hook's, so it observes the guard's verdict and then stops the click itself —
 * otherwise every un-guarded case would have jsdom attempt a real navigation and
 * print "Not implemented: navigation to another Document" over the run.
 */
function clickAndSeeIfBlocked(el: Element): boolean {
  let blocked = false;
  const probe = (ev: Event) => {
    blocked = ev.defaultPrevented;
    ev.preventDefault();
  };
  document.addEventListener("click", probe, true);
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  } finally {
    document.removeEventListener("click", probe, true);
  }
  return blocked;
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetDirtyGuard();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  confirmSpy.mockRestore();
  resetDirtyGuard();
});

describe("isGuardedNavigation · what must never be swallowed", () => {
  const plain = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  const anchor = (attrs: Record<string, string>) => {
    const a = document.createElement("a");
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    return a;
  };

  it("guards an ordinary in-app link", () => {
    expect(isGuardedNavigation(plain, anchor({ href: "/dashboard" }))).toBe(true);
  });

  it("guards a desktop HashRouter link — every .exe link looks like this", () => {
    // Writing this test is what found it: an "ignore all # hrefs" rule reads as
    // correct on the web and leaves the packaged app with NO anchor guard at all,
    // because there every in-app link is "#/…".
    expect(isGuardedNavigation(plain, anchor({ href: "#/dashboard" }))).toBe(true);
    expect(isGuardedNavigation(plain, anchor({ href: "#/events/abc?tab=setlist" }))).toBe(true);
  });

  it("does NOT guard the Google Map link (target=_blank stays on this page)", () => {
    expect(
      isGuardedNavigation(plain, anchor({ href: "https://maps.example", target: "_blank" }))
    ).toBe(false);
  });

  it("does NOT guard a download, an external scheme, or a bare tab hash", () => {
    expect(isGuardedNavigation(plain, anchor({ href: "/x.csv", download: "" }))).toBe(false);
    expect(isGuardedNavigation(plain, anchor({ href: "mailto:a@b.c" }))).toBe(false);
    expect(isGuardedNavigation(plain, anchor({ href: "tel:+66" }))).toBe(false);
    expect(isGuardedNavigation(plain, anchor({ href: "#summary" }))).toBe(false);
    expect(isGuardedNavigation(plain, anchor({ href: "#setlist" }))).toBe(false);
  });

  it("does NOT guard a ctrl/meta/middle click — the browser opens a new tab", () => {
    const a = anchor({ href: "/dashboard" });
    expect(isGuardedNavigation({ ...plain, metaKey: true }, a)).toBe(false);
    expect(isGuardedNavigation({ ...plain, ctrlKey: true }, a)).toBe(false);
    expect(isGuardedNavigation({ ...plain, button: 1 }, a)).toBe(false);
    expect(isGuardedNavigation({ ...plain, defaultPrevented: true }, a)).toBe(false);
  });
});

describe("useLeaveGuard · clicking away", () => {
  it("does not interrupt anything when every write has landed", () => {
    const { getByTestId } = render(<Harness />);
    markPending();
    markSettled(true);
    expect(clickAndSeeIfBlocked(getByTestId("in-app"))).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("asks before leaving when a write FAILED, and staying cancels the click", () => {
    const { getByTestId } = render(<Harness />);
    markPending();
    markSettled(false);
    expect(clickAndSeeIfBlocked(getByTestId("in-app"))).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("ยังบันทึกไม่สำเร็จ");
  });

  it("asks while a write is still in flight", () => {
    const { getByTestId } = render(<Harness />);
    markPending();
    expect(clickAndSeeIfBlocked(getByTestId("in-app"))).toBe(true);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("กำลังบันทึกอยู่");
  });

  it("stays silent on the map link even with a failed write", () => {
    const { getByTestId } = render(<Harness />);
    markPending();
    markSettled(false);
    expect(clickAndSeeIfBlocked(getByTestId("map"))).toBe(false);
    expect(clickAndSeeIfBlocked(getByTestId("tab-hash"))).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("COMMITS a focused field first, so typing then clicking away is a save", () => {
    // The ordinary case: someone types a stage time and taps the logo. Blurring
    // gives the editor its normal onBlur → persist path; only if THAT does not
    // land does anyone see a dialog.
    const onBlur = vi.fn();
    const { getByTestId } = render(<Harness />);
    const field = getByTestId("field") as HTMLInputElement;
    field.addEventListener("blur", onBlur);
    field.focus();
    expect(document.activeElement).toBe(field);
    clickAndSeeIfBlocked(getByTestId("in-app"));
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("is inert when disabled (a read-only viewer, a template)", () => {
    const { getByTestId } = render(<Harness enabled={false} />);
    markPending();
    markSettled(false);
    expect(clickAndSeeIfBlocked(getByTestId("in-app"))).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("stops guarding once the workspace unmounts", () => {
    const { getByTestId, unmount } = render(<Harness />);
    markPending();
    markSettled(false);
    const link = getByTestId("in-app");
    document.body.appendChild(link); // survive the unmount so it is still clickable
    unmount();
    expect(clickAndSeeIfBlocked(link)).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("useLeaveGuard · closing the tab", () => {
  const fireBeforeUnload = () => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it("does not block a close when nothing is outstanding", () => {
    render(<Harness />);
    expect(fireBeforeUnload()).toBe(false);
  });

  it("blocks a close while something has not saved", () => {
    render(<Harness />);
    markPending();
    markSettled(false);
    expect(hasUnsavedWork()).toBe(true);
    expect(fireBeforeUnload()).toBe(true);
  });

  it("tells Electron this is the UNSAVED guard, not a running show", () => {
    // main.cjs replaces the browser confirm with its own dialog and, before this,
    // hardcoded "โชว์กำลังดำเนินอยู่" — a sentence that is simply false during an
    // edit, and one dismissed often enough stops being read when it is true.
    const setUnloadReason = vi.fn(async () => {});
    window.cueiqNative = {
      isElectron: true,
      fetchAudio: vi.fn(),
      putAudio: vi.fn(),
      pickAudioFile: vi.fn(),
      setShowRunning: vi.fn(),
      setUnloadReason,
    } as unknown as Window["cueiqNative"];
    const { unmount } = render(<Harness />);
    markPending();
    markSettled(false);
    fireBeforeUnload();
    expect(setUnloadReason).toHaveBeenCalledWith("unsaved");
    unmount();
    expect(setUnloadReason).toHaveBeenLastCalledWith(null);
    delete window.cueiqNative;
  });
});
