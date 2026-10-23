// The desktop sign-in screen, against the web one (FINAL-SPEC-v3 §G.9): the same
// LoginForm slab on the dark stage — and, since v3, under the same page light.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login";
import { clearMgmtOutbox, enqueueMgmtOp, queuedMgmtWorkCount } from "~/data/mgmt-outbox";

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

// 2026-10-24: a session that dies on its own (revoked from another device, refused by a
// captive portal) no longer wipes the offline management queue — but that work goes
// out only when the SAME account signs back in, so the sign-in screen has to say it is
// there before the person types another name. A deliberate sign-out wipes it first.
describe("desktop Login — venue work still on this machine", () => {
  const STORED = "sb-kewyqqxohckurwuepucv-auth-token";

  beforeEach(async () => {
    window.localStorage.clear();
    await clearMgmtOutbox();
  });

  function renderLogin() {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
  }

  it("says how much is queued and that the same account sends it", async () => {
    window.localStorage.setItem(
      STORED,
      JSON.stringify({ refresh_token: "r", user: { id: "11111111-1111-4111-8111-111111111111" } })
    );
    await enqueueMgmtOp({ kind: "event.delete", base: null, id: "aaaaaaaa-0000-4000-8000-000000000001" });
    await enqueueMgmtOp({ kind: "event.delete", base: null, id: "aaaaaaaa-0000-4000-8000-000000000002" });
    window.localStorage.clear(); // the session died: auth-js removed it

    renderLogin();
    const notice = await screen.findByTestId("queued-work-notice");
    expect(notice).toHaveTextContent("มีงานค้างซิงค์ 2 รายการในเครื่องนี้");
    expect(notice).toHaveTextContent("เข้าสู่ระบบด้วยบัญชีเดิม");
    expect(notice).toHaveAttribute("role", "status");
  });

  it("says nothing on a machine with nothing queued", async () => {
    renderLogin();
    // let the count settle before asserting it never showed
    await act(async () => {
      await queuedMgmtWorkCount();
    });
    expect(screen.queryByTestId("queued-work-notice")).toBeNull();
  });
});
