import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QuickShowLink } from "./quick-show-link";

// The Quick Show door, one copy for sign-in / boot / shell fallback / the event
// page's dead end (each of those screens' own tests pins that it is mounted there).
describe("QuickShowLink", () => {
  const renderIt = (className?: string) =>
    render(
      <MemoryRouter>
        <QuickShowLink className={className} />
      </MemoryRouter>
    );

  it("is a link to the local runner, named so a screen reader and the existing tests can find it", () => {
    renderIt();
    const link = screen.getByRole("link", { name: /Quick Show/ });
    expect(link.getAttribute("href")).toBe("/my-show");
    expect(link).toBe(screen.getByTestId("quick-show-link"));
    expect(link.textContent).toContain("ไม่ต้องเข้าสู่ระบบ");
  });

  it("is the redesign's slab with the band colour on its left edge, 64 px tall at least", () => {
    renderIt();
    const cls = screen.getByTestId("quick-show-link").className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["rounded-[3px]", "bg-card", "min-h-[64px]"]));
    expect(screen.getByTestId("quick-show-link").className).toContain("inset_3px_0_0_hsl(var(--primary))");
    // none of the pre-redesign card's look
    expect(cls).not.toContain("rounded-xl");
    expect(cls).not.toContain("border-2");
  });

  it("takes a className without losing its own", () => {
    renderIt("mt-4");
    const cls = screen.getByTestId("quick-show-link").className.split(/\s+/);
    expect(cls).toContain("mt-4");
    expect(cls).toContain("min-h-[64px]");
  });
});
