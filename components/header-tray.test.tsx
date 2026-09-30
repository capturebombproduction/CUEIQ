// The phone header, 2026-10-01: four sticky rows (167px, a fifth of a 390px
// screen) became two by folding five seldom-used icons behind "⋯". Pinned: the
// tray starts closed on a phone, "⋯" opens and closes it, moving to another page
// closes it, and the tools inside are the real, working controls.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { HeaderTray } from "./header-tray";

beforeEach(() => {
  nav.path = "/dashboard";
});

const tray = () => screen.getByTestId("header-tray");
const classes = (el: Element) => el.className.split(/\s+/);

const mount = () =>
  render(
    <HeaderTray identity={<span>seishin-mem</span>}>
      <button type="button" aria-label="สลับธีมสว่าง/มืด" />
      <button type="button" aria-label="ออกจากระบบ" />
    </HeaderTray>
  );

describe("HeaderTray", () => {
  it("starts closed on a phone and shows inline from sm up", () => {
    mount();
    expect(classes(tray())).toContain("hidden");
    expect(classes(tray())).toContain("sm:flex");
    expect(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("⋯ opens it and ✕ closes it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }));
    expect(classes(tray())).not.toContain("hidden");
    expect(screen.getByRole("button", { name: "ปิดเมนู" }).getAttribute("aria-expanded")).toBe("true");
    expect(tray()).toHaveTextContent("seishin-mem");
    fireEvent.click(screen.getByRole("button", { name: "ปิดเมนู" }));
    expect(classes(tray())).toContain("hidden");
  });

  it("closes itself when the page changes", () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }));
    nav.path = "/practice";
    rerender(
      <HeaderTray identity={<span>seishin-mem</span>}>
        <button type="button" aria-label="สลับธีมสว่าง/มืด" />
        <button type="button" aria-label="ออกจากระบบ" />
      </HeaderTray>
    );
    expect(classes(tray())).toContain("hidden");
  });

  it("holds each tool once — hidden by CSS, never mounted twice", () => {
    mount();
    expect(screen.getAllByRole("button", { name: "ออกจากระบบ", hidden: true })).toHaveLength(1);
  });
});
