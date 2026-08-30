// The receipt, and the counter behind it.
//
// The counter half is the one with teeth: EventWorkspace keeps every opened tab
// mounted and re-keys a HIDDEN one whenever server props change, so two editors'
// writes share one module-level `pending` and one of them can be torn down
// mid-write at any moment. Getting that wrong makes the leave-the-page warning
// either cry wolf or go silent, and both are worse than not having it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { SaveStatus, useSaveSignal } from "@/components/event/save-status";
import { resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";

let handle: ReturnType<typeof useSaveSignal> | null = null;

function Editor({ id = "a" }: { id?: string }) {
  const save = useSaveSignal();
  handle = save;
  return (
    <div data-testid={`editor-${id}`}>
      <SaveStatus state={save.state} />
    </div>
  );
}

/** Grab the hook handle a freshly rendered <Editor> published. */
function mountEditor(id: string) {
  const r = render(<Editor id={id} />);
  const h = handle!;
  return { ...r, save: h };
}

beforeEach(() => resetDirtyGuard());
afterEach(() => {
  cleanup();
  resetDirtyGuard();
  handle = null;
});

describe("the badge", () => {
  it("says nothing at all until a write happens", () => {
    mountEditor("a");
    expect(screen.queryByTestId("save-status")).toBeNull();
  });

  it("goes กำลังบันทึก… then บันทึกแล้ว, and the บันทึกแล้ว does not time out", () => {
    const { save } = mountEditor("a");
    act(() => save.begin());
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "saving");
    act(() => save.end(true));
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "saved");
  });

  it("a failure outranks anything still in flight", () => {
    const { save } = mountEditor("a");
    act(() => {
      save.begin();
      save.begin();
      save.end(false);
    });
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "failed");
    act(() => save.end(true));
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save-state", "failed");
  });
});

describe("the shared counter", () => {
  it("reports every write to the module-level guard", () => {
    const { save } = mountEditor("a");
    act(() => save.begin());
    expect(unsavedWork().pending).toBe(1);
    act(() => save.end(true));
    expect(unsavedWork()).toEqual({ pending: 0, failed: 0 });
  });

  it("records a real failure for the leave-the-page warning to find", () => {
    const { save } = mountEditor("a");
    act(() => {
      save.begin();
      save.end(false);
    });
    expect(unsavedWork().failed).toBe(1);
  });
});

describe("an editor torn down mid-write", () => {
  it("counts its writes out exactly once, and never as a failure", () => {
    const { save, unmount } = mountEditor("a");
    act(() => save.begin());
    expect(unsavedWork().pending).toBe(1);
    unmount();
    expect(unsavedWork()).toEqual({ pending: 0, failed: 0 });
    // The fetch is NOT aborted, so its end() still fires afterwards. It must be a
    // no-op: markAbandoned already accounted for this write.
    act(() => save.end(false));
    expect(unsavedWork()).toEqual({ pending: 0, failed: 0 });
  });

  it("cannot cancel ANOTHER still-mounted editor's pending write", () => {
    // The case the Math.max(0, …) clamps cannot save you from, and the one that
    // actually happens: the setlist tab is saving while a router.refresh() re-keys
    // the hidden schedule panel, which remounts and abandons its own write.
    const a = mountEditor("a"); // stays mounted
    const b = mountEditor("b"); // will be re-keyed away
    act(() => {
      a.save.begin();
      b.save.begin();
    });
    expect(unsavedWork().pending).toBe(2);
    b.unmount();
    expect(unsavedWork().pending).toBe(1); // only b's was abandoned
    act(() => b.save.end(true)); // b's late settle — must not touch a's
    expect(unsavedWork().pending).toBe(1);
    act(() => a.save.end(true));
    expect(unsavedWork().pending).toBe(0);
  });

  it("a late FAILURE from an abandoned write does not plant a sticky warning", () => {
    // markAbandoned's contract: stop counting it, but do NOT record a failure —
    // the user was asked at the moment they left, and warning them again on the
    // next page about a write nobody is waiting for is noise.
    const { save, unmount } = mountEditor("a");
    act(() => save.begin());
    unmount();
    act(() => save.end(false));
    expect(unsavedWork().failed).toBe(0);
  });
});
