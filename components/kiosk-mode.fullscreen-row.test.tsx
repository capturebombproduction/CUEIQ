// Hunt 3 (2026-10-27), shell-5: the account panel's Fullscreen switch disappeared while the page IS
// fullscreen. useFullscreen() (components/kiosk-mode.tsx) re-evaluates
// `available = !isStandalone() && fsSupported()` every time the panel's rows mount
// (each open), and isStandalone() counts `(display-mode: fullscreen)` - which Chromium
// reports for a tab in HTML fullscreen (Browser::GetDisplayMode: window fullscreen ->
// kFullscreen). So: turn it on, close the panel, reopen it to turn it off -> no row.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, cleanup } from "@testing-library/react";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/components/notifications/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/install-button", () => ({ InstallButton: () => null }));

import { FeedbackUnreadProvider } from "@/components/feedback-button";
import { AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { TabBar } from "@/components/tab-bar";

const MEMBER = makePerms("member", [{ group_id: "g1", role: "member" } as never]);

afterEach(() => {
  cleanup();
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
});

describe("Fullscreen switch in the account panel", () => {
  it("is still there to turn fullscreen OFF", async () => {
    h.supa = makeSupabaseFake({ script: { feedback: ok([]) } });
    let fs: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fs });
    (document.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen = vi.fn(async () => {
      fs = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const realMM = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("display-mode: fullscreen") ? fs !== null : false,
      media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      await act(async () => {
        render(
          <FeedbackUnreadProvider userId="u1">
            <AccountPanelProvider>
              <TabBar perms={MEMBER} />
              <AccountPanel name="มายด์" perms={MEMBER} userId="u1" tenantId="t1" canEdit={false} />
            </AccountPanelProvider>
          </FeedbackUnreadProvider>
        );
      });
      fireEvent.click(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }));
      await act(async () => {
        fireEvent.click(within(screen.getByTestId("account-panel")).getByRole("switch", { name: /Fullscreen/ }));
      });
      expect(fs).not.toBeNull();
      // close the panel, then reopen it to switch fullscreen off
      fireEvent.click(screen.getByRole("button", { name: "ปิดเมนู" }));
      fireEvent.click(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }));
      await act(async () => {});
      expect(within(screen.getByTestId("account-panel")).queryByRole("switch", { name: /Fullscreen/ })).not.toBeNull();
    } finally {
      window.matchMedia = realMM;
    }
  });
});
