// The sign-in slab (spec §G.9). The redesign added a show-password toggle and moved
// the brand inside; what it must NOT move is what the desktop smoke drives by hand —
// #loginId, #password and the first <form> (desktop/electron/main.cjs
// signInThroughTheForm) — or what the form sends.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  signIn: vi.fn(async () => ({ error: null })),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: h.signIn } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LoginForm } from "@/components/auth/login-form";
import { loginIdToEmail } from "@/lib/username";

beforeEach(() => {
  h.signIn.mockClear();
  h.replace.mockClear();
});
afterEach(() => cleanup());

describe("LoginForm", () => {
  it("shows the password on request and hides it again, on the same #password field", () => {
    render(<LoginForm />);
    const pw = document.getElementById("password") as HTMLInputElement;
    expect(pw.type).toBe("password");

    const toggle = screen.getByRole("button", { name: "แสดงรหัสผ่าน" });
    expect(toggle).toHaveAttribute("type", "button"); // never submits the form
    fireEvent.click(toggle);
    expect(document.getElementById("password")).toBe(pw);
    expect(pw.type).toBe("text");
    expect(screen.getByRole("button", { name: "ซ่อนรหัสผ่าน" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "ซ่อนรหัสผ่าน" }));
    expect(pw.type).toBe("password");
  });

  it("is still driven by #loginId, #password and the first form, and sends the same sign-in", async () => {
    render(<LoginForm next="/overview" />);
    fireEvent.change(document.getElementById("loginId")!, { target: { value: "seishin-mem" } });
    fireEvent.change(document.getElementById("password")!, { target: { value: "hunter22" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() =>
      expect(h.signIn).toHaveBeenCalledWith({ email: loginIdToEmail("seishin-mem"), password: "hunter22" })
    );
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/overview"));
    // 16 px fields on every width: iOS zooms into anything smaller.
    for (const id of ["loginId", "password"]) {
      expect(document.getElementById(id)!.className).toContain("sm:text-base");
    }
  });

  // CQ-59: a phone held sideways is ~390px tall and the slab is ~480px, so the sign-in
  // button landed mostly below the fold. Under 500px of height the slab's padding and
  // gaps tighten. jsdom has no layout (and never matches a media query), so these pin
  // WHICH classes carry the short-viewport rule; "the button's bottom is inside 844x390"
  // is the harness's measurement. What must NOT shrink is pinned too: the fields and
  // the eye are touch targets.
  it("tightens its padding and gaps on a short viewport, and keeps every touch target", () => {
    const { container } = render(<LoginForm />);
    const SHORT = "[@media(max-height:500px)]:";
    const has = (el: Element, cls: string) => el.className.split(/\s+/).includes(SHORT + cls);

    expect(has(container.querySelector(".slab")!, "p-4")).toBe(true);
    const mark = container.querySelector(".brand-mark")!;
    expect(has(mark, "h-9") && has(mark, "w-9")).toBe(true);
    const form = container.querySelector("form")!;
    expect(has(form, "mt-3") && has(form, "space-y-2")).toBe(true);

    // 48px fields, 44px eye, 48px button: untouched by the short-viewport rule
    for (const id of ["loginId", "password"]) {
      const field = document.getElementById(id)!;
      expect(field.className).toContain("h-12");
      expect(field.className).not.toContain("max-height");
    }
    const eye = screen.getByRole("button", { name: "แสดงรหัสผ่าน" });
    expect(eye.className).toContain("h-11");
    expect(eye.className).not.toContain("max-height");
    const submit = screen.getByRole("button", { name: "เข้าสู่ระบบ" });
    expect(submit.className).toContain("h-12");
    expect(submit.className).not.toContain("max-height");
  });
});
