// What must never fold behind the phone header's "⋯": the bell (feedback replies,
// show reminders) and the install button (the step push needs on an iPhone —
// push reached 1 of 19 accounts when this was written). Everything else may.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { makePerms } from "@/lib/permissions";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <button type="button" aria-label="การแจ้งเตือน" />,
}));
vi.mock("@/components/install-button", () => ({
  InstallButton: () => <button type="button" aria-label="ติดตั้งแอป" />,
}));
vi.mock("@/components/kiosk-mode", () => ({ KioskMode: () => <button type="button" aria-label="เต็มจอ" /> }));
vi.mock("@/components/accent-picker", () => ({ AccentPicker: () => <button type="button" aria-label="สี" /> }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => <button type="button" aria-label="ธีม" /> }));
vi.mock("@/components/change-password-button", () => ({
  ChangePasswordButton: () => <button type="button" aria-label="รหัสผ่าน" />,
}));
vi.mock("@/components/sign-out-button", () => ({ SignOutButton: () => <button type="button" aria-label="ออกจากระบบ" /> }));

import { SiteHeader } from "./site-header";

describe("SiteHeader — what stays on the phone's top row", () => {
  it("keeps the bell and install outside the ⋯ tray, and the other tools inside it", () => {
    render(
      <SiteHeader
        name="seishin-mem"
        role="member"
        perms={makePerms("member", [{ group_id: "g1", role: "member" } as never])}
        userId="u1"
        tenantId="t1"
      />
    );
    const tray = screen.getByTestId("header-tray");
    for (const kept of ["การแจ้งเตือน", "ติดตั้งแอป"]) {
      expect(tray.contains(screen.getByRole("button", { name: kept }))).toBe(false);
    }
    for (const folded of ["เต็มจอ", "สี", "ธีม", "รหัสผ่าน", "ออกจากระบบ"]) {
      expect(tray.contains(screen.getByRole("button", { name: folded, hidden: true }))).toBe(true);
    }
  });
});
