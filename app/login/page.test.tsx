// The sign-in screen (FINAL-SPEC-v3 §G.9): full-screen bg-background under the page
// light, one centred slab. The slab itself is components/auth/login-form.test.tsx's.
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: vi.fn(async () => ({ error: null })) } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import LoginPage from "@/app/login/page";

describe("login page — the page light (v3)", () => {
  it("hangs ONE light as the screen's first element, in an isolated screen", async () => {
    const { container } = render(await LoginPage({ searchParams: Promise.resolve({}) }));
    const main = container.querySelector("main")!;
    const lights = container.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    expect(main.firstElementChild).toBe(lights[0]);
    expect(lights[0]).toHaveAttribute("aria-hidden", "true");
    // isolate: the light (z-index -1) paints over this screen's background and
    // under the slab — not under the body behind it
    expect(main.className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "isolate", "bg-background"]));
    expect(container.querySelector("form")).toBeTruthy();
  });
});
