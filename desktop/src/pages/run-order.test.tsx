import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import type { WorkspaceData } from "~/data/workspace";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP RUNNING-ORDER BUILDER PAGE — its header, mirrored from the web page
// (app/(app)/events/[id]/run-order/page.tsx): the English display H1, 44 px ways off
// the page, and an offline notice that says what it is with an icon and words. The
// builder itself is mocked: components/event/run-order-builder.test.tsx covers it.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ res: null as unknown, ws: null as unknown }));

vi.mock("~/data/run-order", () => ({
  loadRunOrderBuild: vi.fn(() => Promise.resolve(h.res)),
}));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/event/run-order-builder", () => ({
  RunOrderBuilder: () => <div data-testid="builder" />,
}));

import { RunOrderPage } from "./run-order";

const EVENT_ID = "ev-1";
const DATA = { name: "A Lot Of Tone Fest", date: "2026-08-09", seqs: [], bandEvents: [] };

const ADMIN: WorkspaceData = {
  user: { id: "u1", email: "staff@cueiq.local", name: "Staff" },
  membership: { tenant_id: "tenant-a", role: "admin" },
  tenant: null,
  groups: [],
  groupRoles: [],
  perms: makePerms("admin"),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}/run-order`]}>
      <Routes>
        <Route path="/events/:id/run-order" element={<RunOrderPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  h.ws = ADMIN;
  h.res = { status: "ok", data: DATA, fromCache: false };
});

describe("desktop RunOrderPage — the page header", () => {
  it("is an English display H1 with 44 px ways back and into the live caller", async () => {
    renderPage();
    await screen.findByTestId("builder");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Running Order");
    expect(h1.classList.contains("h1")).toBe(true);

    const back = screen.getByRole("link", { name: /A Lot Of Tone Fest/ });
    expect(back.getAttribute("href")).toBe(`/events/${EVENT_ID}`);
    expect(back.className).toMatch(/(^|\s)h-11(\s|$)/);

    const live = screen.getByRole("link", { name: /คุมคิว/ });
    expect(live.getAttribute("href")).toBe(`/events/${EVENT_ID}/run-order/live`);
    expect(live.className).toMatch(/(^|\s)h-11(\s|$)/);
  });

  it("a board served from disk says so with an icon and the words, in a warning tint", async () => {
    h.res = { status: "ok", data: DATA, fromCache: true };
    renderPage();
    await screen.findByTestId("builder");
    const copy = screen.getByText(/นี่คือลำดับงานที่เครื่องนี้เก็บไว้ล่าสุด/);
    const notice = copy.closest("p")!;
    expect(notice.querySelector("svg.lucide-wifi-off")).not.toBeNull();
    expect(notice.className).toMatch(/bg-warning/);
  });
});
