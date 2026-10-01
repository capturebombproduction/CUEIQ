// The app header after the redesign (FINAL-SPEC-v2 §F.1): ONE row on every screen.
// What must never fold away: the bell (feedback replies, show reminders) and the
// install button (the step push needs on an iPhone — push reached 1 of 19 accounts
// when this was written). What must never come back: the account tools — they live
// in the More sheet now (account-panel.test.tsx pins the other half).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { makePerms } from "@/lib/permissions";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <button type="button" aria-label="การแจ้งเตือน" />,
}));
vi.mock("@/components/install-button", () => ({
  InstallButton: () => <button type="button" aria-label="ติดตั้งแอป" />,
}));

import { SiteHeader } from "./site-header";
import { AccountPanelProvider } from "./account-panel";
import { OfflineBanner } from "./offline-banner";
import { WHATS_NEW_ROUND } from "./whats-new";

const MEMBER = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
const STAFF = makePerms("label_staff");

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

async function mount(perms = MEMBER, extra?: React.ReactNode) {
  await act(async () => {
    render(
      <AccountPanelProvider>
        {extra}
        <SiteHeader name="seishin-mem" perms={perms} userId="u1" tenantId="t1" />
      </AccountPanelProvider>
    );
  });
  return screen.getByRole("banner");
}

beforeEach(() => {
  nav.path = "/dashboard";
  localStorage.setItem("cueiq:whats-new-seen", WHATS_NEW_ROUND);
});
afterEach(() => setOnline(true));

describe("SiteHeader — one row", () => {
  it("keeps the bell and install in the header, on every screen size", async () => {
    const header = await mount();
    expect(within(header).getByRole("button", { name: "การแจ้งเตือน" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "ติดตั้งแอป" })).toBeTruthy();
  });

  it("holds none of the account tools — they moved to the More sheet", async () => {
    const header = await mount();
    for (const gone of [/ธีม|Dark|Light/, /สี/, /รหัสผ่าน|password/i, /เต็มจอ|Fullscreen/, "ออกจากระบบ"]) {
      expect(within(header).queryByRole("button", { name: gone, hidden: true })).toBeNull();
    }
    expect(within(header).queryByRole("radio", { hidden: true })).toBeNull();
    // …and no floating แจ้งปัญหา either: the Feedback tile is in the sheet.
    expect(within(header).queryByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeNull();
  });

  it("is a single row: the nav (lg) and the avatar sit in it, not on a row below", async () => {
    const header = await mount();
    expect(header.children).toHaveLength(1); // online → no strip, just the row
    const row = header.children[0];
    expect(within(row as HTMLElement).getByRole("navigation", { name: "เมนูหลัก" })).toBeTruthy();
    expect(within(row as HTMLElement).getByRole("button", { name: "เมนูบัญชี" })).toBeTruthy();
  });

  it("is glass and sticky, padded for the notch", async () => {
    const cls = (await mount()).className.split(/\s+/);
    for (const c of ["glass", "glass-top", "sticky", "top-0", "pt-[env(safe-area-inset-top)]"]) {
      expect(cls).toContain(c);
    }
  });
});

describe("SiteHeader — the left slot", () => {
  const back = (header: HTMLElement) =>
    within(header).queryByTitle(/^กลับไป /) as HTMLAnchorElement | null;

  it("shows the wordmark on a top-level page, linking home", async () => {
    const header = await mount();
    expect(back(header)).toBeNull();
    expect(within(header).getByRole("link", { name: "CueIQ" }).getAttribute("href")).toBe("/dashboard");
  });

  it("a show page trades it for ‹ EVENTS on a phone", async () => {
    nav.path = "/events/e1";
    const link = back(await mount());
    expect(link?.getAttribute("href")).toBe("/dashboard");
    expect(link).toHaveTextContent("Events");
    expect(link?.className).toContain("lg:hidden"); // lg+: the inline nav is the way back
  });

  it("a show's practice room goes back to Training, its editor to Events", async () => {
    nav.path = "/events/e1/practice";
    expect(back(await mount())?.getAttribute("href")).toBe("/practice");
    document.body.innerHTML = "";
    nav.path = "/events/e1/edit";
    expect(back(await mount())?.getAttribute("href")).toBe("/dashboard");
  });

  it("label staff, who have no Events, go back to Overview", async () => {
    nav.path = "/events/e1/run-order";
    const link = back(await mount(STAFF));
    expect(link?.getAttribute("href")).toBe("/overview");
    expect(link).toHaveTextContent("Overview");
  });
});

describe("SiteHeader — offline", () => {
  const TEXT = /ออฟไลน์ — กำลังใช้ข้อมูลและไฟล์เพลงที่บันทึกไว้ในเครื่อง/;

  it("the strip is the header's own second row, and the page-level copy stands down", async () => {
    setOnline(false);
    // The root layout's in-flow strip is mounted too, as it is on every (app) page.
    const header = await mount(MEMBER, <OfflineBanner />);
    expect(within(header).getByText(TEXT)).toBeTruthy();
    expect(screen.getAllByText(TEXT)).toHaveLength(1);
  });
});
