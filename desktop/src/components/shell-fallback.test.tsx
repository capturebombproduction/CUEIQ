import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makeSupabaseFake } from "@/test/fakes/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// THE SHELL'S FALLBACK SCREEN — "signed in, and showing nothing".
//
// Shown while the workspace loads and when it failed to load. It is the screen the
// packaged app's self-test calls "shell-fallback" (data-cueiq-screen) and tells apart
// from "shell" (the offline cache was honoured) by that attribute alone — so the
// attributes stay, and the look moves: the same Black Stage wrapper as the sign-in
// screen (bg-background, one page light, the wordmark on a slab) and the SAME Quick
// Show door as sign-in, boot and the event page's dead end.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  supa: null as unknown,
  state: { loading: true, ws: null as unknown, reload: () => {} },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("~/components/mgmt-sync-status", () => ({ MgmtSyncStatus: () => null }));
vi.mock("@/components/outbox-flusher", () => ({ OutboxFlusher: () => null }));
vi.mock("~/data/workspace-context", () => ({ useWorkspace: () => h.state }));

import { Shell } from "./shell";

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Shell />
    </MemoryRouter>
  );
}

const fallback = () => document.querySelector('[data-cueiq-screen="shell-fallback"]') as HTMLElement;

beforeEach(() => {
  h.supa = makeSupabaseFake();
  h.state = { loading: true, ws: null, reload: vi.fn() };
});

describe("desktop Shell fallback — loading", () => {
  it("keeps the self-test's markers: shell-fallback, not failed", () => {
    renderShell();
    expect(fallback()).not.toBeNull();
    expect(fallback().getAttribute("data-cueiq-failed")).toBe("0");
    expect(document.querySelector('[data-cueiq-screen="shell"]')).toBeNull();
    expect(screen.getByText("กำลังโหลด…")).toBeTruthy();
  });

  it("is the sign-in screen's wrapper: bg-background, ONE light as its first element", () => {
    renderShell();
    const cls = fallback().className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["relative", "isolate", "bg-background"]));
    expect(cls).not.toContain("bg-muted/30");
    const lights = document.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    expect(fallback().firstElementChild).toBe(lights[0]);
    expect(lights[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("carries the wordmark as its h1, on a slab", () => {
    renderShell();
    const h1 = within(fallback()).getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("CueIQ");
    expect(h1.closest(".slab")).not.toBeNull();
  });

  it("offers the shared Quick Show door", () => {
    renderShell();
    const door = within(fallback()).getByTestId("quick-show-link");
    expect(door.getAttribute("href")).toBe("/my-show");
  });
});

describe("desktop Shell fallback — the workspace failed to load", () => {
  beforeEach(() => {
    h.state = { loading: false, ws: null, reload: vi.fn() };
  });

  it("says so, marks itself failed, and still offers a retry, sign-out and Quick Show", () => {
    renderShell();
    expect(fallback().getAttribute("data-cueiq-failed")).toBe("1");
    expect(screen.getByText(/โหลดข้อมูลไม่สำเร็จ/)).toBeTruthy();
    const screenEl = within(fallback());
    expect(screenEl.getByRole("button", { name: "ลองใหม่" })).toBeTruthy();
    expect(screenEl.getByRole("button", { name: /ออกจากระบบ/ })).toBeTruthy();
    expect(screenEl.getByTestId("quick-show-link")).toBeTruthy();
  });

  it("the retry button calls reload", () => {
    renderShell();
    fireEvent.click(within(fallback()).getByRole("button", { name: "ลองใหม่" }));
    expect(h.state.reload).toHaveBeenCalledTimes(1);
  });

  // A slow boot passes from the boot screen (RefreshButton: default size, the turn icon) to
  // this one; the retry button used to shrink to size "sm" and lose its icon on the way.
  it("its retry is the boot screen's button: full size, with the turn icon", () => {
    renderShell();
    const retry = within(fallback()).getByRole("button", { name: "ลองใหม่" });
    expect(retry.querySelector("svg")).not.toBeNull();
    expect(retry.className).not.toMatch(/(^|\s)h-9(\s|$)/); // Button size="sm"
  });
});
