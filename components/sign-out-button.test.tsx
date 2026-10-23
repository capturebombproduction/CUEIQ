// "Sign out" says "ออกจากระบบเครื่องนี้" — this device. auth-js's signOut() defaults to
// scope "global", which revokes EVERY session of the account: a band that shares one
// login between a phone and the stage laptop lost the laptop when the phone signed out
// (found while writing the label's user guide, 2026-10-23).
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

beforeEach(() => {
  h.replace.mockClear();
  h.refresh.mockClear();
  h.signOut.mockReset();
  h.getSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: null } });
});
afterEach(() => cleanup());

function tapSignOut() {
  render(<SignOutButton />);
  fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
}

describe("Sign out leaves the account's other devices signed in", () => {
  it("revokes only this device's session", async () => {
    h.signOut.mockResolvedValue({ error: null });
    tapSignOut();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(h.signOut).not.toHaveBeenCalledWith({ scope: "global" });
  });

  it("offline: the server call fails, the local session is still dropped — and nothing goes global", async () => {
    window.localStorage.setItem("sb-ref-auth-token", "{}");
    h.signOut
      .mockResolvedValueOnce({ error: new Error("Failed to fetch") })
      .mockResolvedValueOnce({ error: null });
    tapSignOut();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(window.localStorage.getItem("sb-ref-auth-token")).toBeNull();
    expect(h.signOut).toHaveBeenCalledTimes(2);
    for (const call of h.signOut.mock.calls) expect(call).toEqual([{ scope: "local" }]);
  });
});
