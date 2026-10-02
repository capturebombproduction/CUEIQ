// The desktop sign-in screen, against the web one (FINAL-SPEC-v3 §G.9): the same
// LoginForm slab on the dark stage — and, since v3, under the same page light.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login";

describe("desktop Login — the page light", () => {
  it("hangs ONE light as the screen's first element, behind the slab", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    const screenEl = document.querySelector('[data-cueiq-screen="login"]')!;
    const lights = document.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    expect(screenEl.firstElementChild).toBe(lights[0]);
    expect(lights[0]).toHaveAttribute("aria-hidden", "true");
    // isolate: the light (z-index -1) paints over this screen's own background and
    // under the slab, not under the page behind it
    expect(screenEl.className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "isolate", "bg-background"]));
    // the self-test's sign-in still finds its form
    expect(document.getElementById("loginId")).toBeTruthy();
  });

  it("offers the shared Quick Show door under the slab", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    const door = screen.getByTestId("quick-show-link");
    expect(door.getAttribute("href")).toBe("/my-show");
    expect(door.closest('[data-cueiq-screen="login"]')).not.toBeNull();
  });
});
