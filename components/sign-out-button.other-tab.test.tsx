// ---------------------------------------------------------------------------
// A SHOW RUNNING IN ANOTHER TAB ASKS TOO (2026-10-30, hunt 12).
//
// What used to go wrong: "is a show running here" is one flag per tab, so ออกจากระบบ pressed in
// a second tab of the browser asked nothing, and the session both tabs share went from under
// the tab running the show. The running tab now keeps a time stamp in localStorage
// (lib/live-guard.ts) and the sign-out reads it. A stamp over 60 s old is a tab that died.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: h.signOut, getSession: async () => ({ data: { session: null } }) },
  }),
}));
vi.mock("@/components/notifications/push-cleanup", () => ({
  cleanupPushOnSignOut: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { SignOutButton } from "@/components/sign-out-button";
import { LIVE_BEACON_MAX_AGE_MS, writeLiveShowBeacon } from "@/lib/live-guard";

const confirm = vi.fn();

beforeEach(() => {
  h.replace.mockClear();
  h.signOut.mockReset();
  h.signOut.mockResolvedValue({ error: null });
  confirm.mockReset();
  vi.stubGlobal("confirm", confirm);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const tap = () => {
  render(<SignOutButton />);
  fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
};

describe("sign-out with a show sounding in another tab", () => {
  it("asks the same question, and No keeps the session", async () => {
    writeLiveShowBeacon(true);
    confirm.mockReturnValue(false);
    tap();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toContain("กำลังรันโชว์อยู่");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("Yes signs out", async () => {
    writeLiveShowBeacon(true);
    confirm.mockReturnValue(true);
    tap();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it("no beacon, a cleared one, or one over its age (the tab died): no question", async () => {
    tap();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(confirm).not.toHaveBeenCalled();
    cleanup();
    h.replace.mockClear();

    writeLiveShowBeacon(true);
    writeLiveShowBeacon(false);
    tap();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(confirm).not.toHaveBeenCalled();
    cleanup();
    h.replace.mockClear();

    writeLiveShowBeacon(true);
    const later = Date.now() + LIVE_BEACON_MAX_AGE_MS;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    tap();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    now.mockRestore();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("storage that refuses to read is no beacon, and does not stop the sign-out", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    tap();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    get.mockRestore();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("the desktop app (one window) neither writes nor reads a beacon", async () => {
    (window as unknown as { cueiqNative?: unknown }).cueiqNative = { isElectron: true };
    try {
      localStorage.setItem("cueiq:live-sounding-at", String(Date.now()));
      tap();
      await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
      expect(confirm).not.toHaveBeenCalled();
      localStorage.clear();
      writeLiveShowBeacon(true);
      expect(localStorage.getItem("cueiq:live-sounding-at")).toBeNull();
    } finally {
      delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
    }
  });
});
