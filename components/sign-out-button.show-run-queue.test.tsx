// The sign-out question counts the show-run queue too (2026-10-30, hunt 10).
//
// It used to count only the desktop's management outbox, so an offline show's run time
// (จบโชว์) and its running-order presses - the cueiq-outbox database, web and desktop -
// went out of the door with the laptop and nobody was told. A sign-out never wipes that
// queue (it waits for the account that queued it), so the question says KEPT, not lost.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh, push: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: h.signOut, getSession: h.getSession } }),
}));
vi.mock("@/components/notifications/push-cleanup", () => ({
  cleanupPushOnSignOut: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { SignOutButton } from "@/components/sign-out-button";
import { enqueue } from "@/lib/show-run-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

/** One running-order press, written straight into the queue's own store (v2, both stores). */
function seedRunSeqPress(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cueiq-outbox", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("ops")) db.createObjectStore("ops");
      if (!db.objectStoreNames.contains("runseq")) db.createObjectStore("runseq");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("runseq", "readwrite");
      tx.objectStore("runseq").put({ rowId: "r1", patch: { status: "live" } }, "r1");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  await deleteDB("cueiq-mgmt-outbox");
  h.replace.mockClear();
  h.signOut.mockReset();
  h.signOut.mockResolvedValue({ error: null });
  h.getSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: null } });
  confirmSpy = vi.spyOn(window, "confirm");
});
afterEach(() => {
  cleanup();
  confirmSpy.mockRestore();
});

function tapSignOut() {
  render(<SignOutButton />);
  fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
}

describe("sign-out asks about the show-run queue", () => {
  it("asks when an offline run time and a cue press are still queued - and staying keeps you in", async () => {
    await enqueue({ kind: "event_last_run", eventId: "ev1", seconds: 1200, at: 1_761_900_000_000 });
    await seedRunSeqPress();
    confirmSpy.mockReturnValue(false);
    tapSignOut();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    const asked = String(confirmSpy.mock.calls[0][0]);
    expect(asked).toContain("ค้างซิงค์ 2 รายการ");
    expect(asked).toContain("ไม่หาย"); // kept, not thrown away
    expect(asked).not.toContain("ทิ้งทั้งหมด");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("goes ahead when the person confirms", async () => {
    await enqueue({ kind: "event_last_run", eventId: "ev1", seconds: 1200, at: 1_761_900_000_000 });
    confirmSpy.mockReturnValue(true);
    tapSignOut();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("asks nothing when nothing is queued (and creates no database to ask)", async () => {
    tapSignOut();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(confirmSpy).not.toHaveBeenCalled();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain("cueiq-outbox");
  });
});
