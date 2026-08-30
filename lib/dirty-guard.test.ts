import { beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeUnsavedWork,
  hasUnsavedWork,
  markAbandoned,
  markPending,
  markSettled,
  resetDirtyGuard,
  unsavedWork,
  unsavedWorkMessage,
} from "@/lib/dirty-guard";

beforeEach(() => resetDirtyGuard());

describe("nothing to lose", () => {
  it("says nothing when no write has been started", () => {
    expect(hasUnsavedWork()).toBe(false);
    expect(unsavedWorkMessage()).toBeNull();
  });

  it("says nothing after a write that succeeded", () => {
    markPending();
    markSettled(true);
    expect(hasUnsavedWork()).toBe(false);
    expect(unsavedWorkMessage()).toBeNull();
  });
});

describe("a write in flight", () => {
  it("warns while it is out, and stops once it lands", () => {
    markPending();
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkMessage()).toContain("กำลังบันทึกอยู่");
    markSettled(true);
    expect(hasUnsavedWork()).toBe(false);
  });

  it("counts, so a batch reorder does not go quiet on its first reply", () => {
    // A reorder is N independent UPDATEs fired together. The old SaveStatus bug
    // this mirrors: the first one back flipped the whole row to "saved".
    markPending();
    markPending();
    markPending();
    markSettled(true);
    expect(hasUnsavedWork()).toBe(true);
    markSettled(true);
    markSettled(true);
    expect(hasUnsavedWork()).toBe(false);
  });

  it("never counts below zero if a settle arrives without a pending", () => {
    markSettled(true);
    expect(unsavedWork().pending).toBe(0);
  });
});

describe("a write that failed", () => {
  it("keeps warning after everything has settled", () => {
    markPending();
    markSettled(false);
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkMessage()).toContain("ยังบันทึกไม่สำเร็จ");
  });

  it("is NOT cleared by a later write succeeding", () => {
    // This is the trap in the rendered SaveStatus state, which resets to "saving"
    // on the next begin(): a guard reading that would be disarmed by the very next
    // keystroke-then-blur, while the row that failed is still not on the server.
    markPending();
    markSettled(false);
    markPending();
    markSettled(true);
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkMessage()).toContain("ยังบันทึกไม่สำเร็จ");
  });

  it("outranks an in-flight write in what it says", () => {
    markPending();
    markSettled(false);
    markPending();
    expect(unsavedWorkMessage()).toContain("ยังบันทึกไม่สำเร็จ");
    expect(unsavedWorkMessage()).not.toContain("กำลังบันทึกอยู่");
  });

  it("is cleared only by telling the user", () => {
    markPending();
    markSettled(false);
    acknowledgeUnsavedWork();
    expect(hasUnsavedWork()).toBe(false);
    expect(unsavedWorkMessage()).toBeNull();
  });
});

describe("wording per exit", () => {
  it("says ออกจากระบบ when it is the sign-out button asking", () => {
    markPending();
    markSettled(false);
    expect(unsavedWorkMessage("signout")).toContain("ออกจากระบบตอนนี้");
    expect(unsavedWorkMessage("page")).toContain("ออกจากหน้านี้ตอนนี้");
  });
});

describe("an editor that unmounted mid-write", () => {
  it("stops counting its writes without inventing a failure", () => {
    // The fetch usually keeps going after an SPA navigation, so we no longer know
    // how it ends. Recording a failure would make the NEXT page warn about a write
    // nobody is waiting for.
    markPending();
    markPending();
    markAbandoned(2);
    expect(hasUnsavedWork()).toBe(false);
    expect(unsavedWork()).toEqual({ pending: 0, failed: 0 });
  });

  it("leaves an EARLIER real failure standing", () => {
    markPending();
    markSettled(false);
    markPending();
    markAbandoned(1);
    expect(hasUnsavedWork()).toBe(true);
  });

  it("ignores nonsense counts", () => {
    markPending();
    markAbandoned(-5);
    expect(unsavedWork().pending).toBe(1);
    markAbandoned(99);
    expect(unsavedWork().pending).toBe(0);
  });
});

describe("what must NOT warn", () => {
  it("an offline-queued write is saved, and the call site reports it as success", () => {
    // The editors call save.end(true) after tryQueueChildList() succeeds — the row
    // is on disk and will flush. Warning here would fire on every edit made at a
    // venue, which is where this app is actually used.
    markPending();
    markSettled(true); // ← what queueOffline() success does
    expect(hasUnsavedWork()).toBe(false);
  });
});
