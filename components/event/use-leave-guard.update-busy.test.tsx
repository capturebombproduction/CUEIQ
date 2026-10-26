// The desktop's update installer asks main.cjs updateBusyReason() whether installing
// now would hurt, and main only knows what the renderer has told it. The "unsaved"
// half used to be told only from inside beforeunload — i.e. once a close was
// already underway — so the update box / ติดตั้ง chip saw "not busy" over a failed
// or in-flight save. On Windows quitAndInstall spawns the installer BEFORE the quit
// this guard then vetoes, and the installer kills the app ~1 s later anyway: the
// edit the operator chose to keep went with it.
//
// main has ONE reason slot, shared with Live Mode / Quick Show ("show"), so the
// guard must never overwrite a show's reason either way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useLeaveGuard } from "@/components/event/use-leave-guard";
import {
  acknowledgeUnsavedWork,
  markPending,
  markSettled,
  resetDirtyGuard,
  setUnsavedDraft,
} from "@/lib/dirty-guard";
import { setLiveShowActive } from "@/lib/live-guard";

function Harness() {
  useLeaveGuard(true);
  return <p>event workspace</p>;
}

let setUnloadReason: ReturnType<typeof vi.fn<(reason: "show" | "unsaved" | null) => Promise<void>>>;
beforeEach(() => {
  resetDirtyGuard();
  setUnloadReason = vi.fn<(reason: "show" | "unsaved" | null) => Promise<void>>(async () => {});
  window.cueiqNative = {
    isElectron: true,
    fetchAudio: vi.fn(),
    putAudio: vi.fn(),
    pickAudioFile: vi.fn(),
    setShowRunning: vi.fn(),
    setUnloadReason,
  } as unknown as Window["cueiqNative"];
});
afterEach(() => {
  cleanup();
  resetDirtyGuard();
  setLiveShowActive(false);
  delete window.cueiqNative;
});

describe("useLeaveGuard · telling the desktop an edit is unsaved", () => {
  it("says 'unsaved' as soon as a save fails — before anything tries to close", () => {
    render(<Harness />);
    markPending();
    markSettled(false);
    expect(setUnloadReason).toHaveBeenCalledWith("unsaved");
  });

  it("…and takes it back once nothing is outstanding", () => {
    render(<Harness />);
    markPending();
    markSettled(false);
    acknowledgeUnsavedWork();
    expect(setUnloadReason).toHaveBeenLastCalledWith(null);
  });

  it("covers a save still on the wire, and an unsaved form", () => {
    render(<Harness />);
    markPending();
    expect(setUnloadReason).toHaveBeenLastCalledWith("unsaved");
    markSettled(true);
    expect(setUnloadReason).toHaveBeenLastCalledWith(null);
    const form = {};
    setUnsavedDraft(form, true);
    expect(setUnloadReason).toHaveBeenLastCalledWith("unsaved");
    setUnsavedDraft(form, false);
    expect(setUnloadReason).toHaveBeenLastCalledWith(null);
  });

  it("re-asserts on mount a failure that was already there", () => {
    // Live Mode's teardown sends null; coming back to the workspace with the old
    // failure still standing must tell main again.
    markPending();
    markSettled(false);
    render(<Harness />);
    expect(setUnloadReason).toHaveBeenCalledWith("unsaved");
  });

  it("does not repeat itself on every write", () => {
    render(<Harness />);
    markPending();
    markPending();
    markSettled(false);
    markSettled(true);
    expect(setUnloadReason.mock.calls.filter((c) => c[0] === "unsaved")).toHaveLength(1);
  });
});

describe("useLeaveGuard · never clobbering a running show's reason", () => {
  it("does not send 'unsaved' while a live show is running here", () => {
    setLiveShowActive(true);
    render(<Harness />);
    markPending();
    markSettled(false);
    expect(setUnloadReason).not.toHaveBeenCalled();
  });

  it("never sends null when it had not said 'unsaved' itself", () => {
    // Mounting and unmounting with nothing outstanding must leave a "show" that
    // someone else set exactly where it was.
    const { unmount } = render(<Harness />);
    unmount();
    expect(setUnloadReason).not.toHaveBeenCalled();
  });
});
