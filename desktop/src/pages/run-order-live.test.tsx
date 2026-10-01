import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { makePerms } from "@/lib/permissions";
import type { WorkspaceData } from "~/data/workspace";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP SHOW-CALLER PAGE — wiring only.
//
// /events/:id/run-order/live is immersive on the desktop too (shell.tsx hides the
// header there), so anything this page renders AROUND the caller sits outside the
// caller's sticky top bar: a back link nobody can reach once the board scrolls, and an
// offline notice pushed above the bar. The caller now owns the top bar, so the page
// hands it the way back and the "saved copy" notice instead. The caller is mocked to
// a prop recorder: its own rendering is components/event/event-live-caller.test.tsx.
// ─────────────────────────────────────────────────────────────────────────────

type CallerProps = {
  canControl: boolean;
  backHref?: string;
  backLabel?: string;
  notice?: ReactNode;
};

const h = vi.hoisted(() => ({
  res: null as unknown,
  ws: null as unknown,
  caller: [] as Record<string, unknown>[],
  /** The load never answers — a joined-but-black-holed venue network. */
  hang: false,
}));

vi.mock("~/data/run-order", () => ({
  loadRunOrderLive: vi.fn(() => (h.hang ? new Promise(() => {}) : Promise.resolve(h.res))),
}));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/event/event-live-caller", () => ({
  EventLiveCaller: (props: Record<string, unknown>) => {
    h.caller.push(props);
    return <div data-testid="caller">{props.notice as ReactNode}</div>;
  },
}));

import { RunOrderLivePage } from "./run-order-live";

const EVENT_ID = "ev-1";
const DATA = { name: "A Lot Of Tone Fest", date: "2026-08-09", seqs: [] };

function workspace(role: "admin" | "member"): WorkspaceData {
  return {
    user: { id: "u1", email: "staff@cueiq.local", name: "Staff" },
    membership: { tenant_id: "tenant-a", role },
    tenant: null,
    groups: [],
    groupRoles: role === "member" ? [{ group_id: "g1", role: "member" }] : [],
    perms: makePerms(role, role === "member" ? [{ group_id: "g1", role: "member" }] : []),
  } as WorkspaceData;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}/run-order/live`]}>
      <Routes>
        <Route path="/events/:id/run-order/live" element={<RunOrderLivePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function lastCaller(): CallerProps {
  return h.caller[h.caller.length - 1] as unknown as CallerProps;
}

beforeEach(() => {
  h.caller = [];
  h.ws = workspace("admin");
  h.res = { status: "ok", data: DATA, fromCache: false };
  h.hang = false;
});

describe("desktop RunOrderLivePage — the caller owns the screen", () => {
  it("renders nothing of its own around the caller (no heading, no back link)", async () => {
    const { container } = renderPage();
    const caller = await screen.findByTestId("caller");
    expect(container.firstElementChild).toBe(caller);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("an approver's back goes to the builder", async () => {
    renderPage();
    await screen.findByTestId("caller");
    expect(lastCaller()).toMatchObject({
      canControl: true,
      backHref: `/events/${EVENT_ID}/run-order`,
      backLabel: "Running Order",
    });
    expect(lastCaller().notice).toBeFalsy();
  });

  it("a watcher's back goes to the event, named as typed", async () => {
    h.ws = workspace("member");
    renderPage();
    await screen.findByTestId("caller");
    expect(lastCaller()).toMatchObject({
      canControl: false,
      backHref: `/events/${EVENT_ID}`,
      backLabel: "A Lot Of Tone Fest",
    });
  });

  it("a board served from disk says so INSIDE the caller, with an icon and the word", async () => {
    h.res = { status: "ok", data: DATA, fromCache: true };
    renderPage();
    const caller = await screen.findByTestId("caller");
    const notice = screen.getByText(/นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/);
    expect(caller.contains(notice)).toBe(true);
    expect(notice.closest("p")?.querySelector("svg.lucide-wifi-off")).not.toBeNull();
  });

  it("a failed read keeps a way out: the header is hidden on this route", async () => {
    h.res = { status: "error" };
    renderPage();
    const back = await screen.findByRole("link", { name: /กลับ/ });
    expect(back.getAttribute("href")).toBe(`/events/${EVENT_ID}`);
    expect(back.className).toMatch(/(^|\s)h-11(\s|$)/);
    expect(screen.getByRole("button", { name: /ลองใหม่/ })).toBeInTheDocument();
  });

  // …and so does a read that has not answered yet: the board's 8 s budgets can hold
  // this screen for a long while on a black-holed venue network, and before the
  // redesign the header's nav and Quick Show stayed clickable through all of it.
  it("a load still in flight keeps a way out too: back to the event, and Quick Show", async () => {
    h.hang = true;
    renderPage();
    expect(screen.getByText("กำลังโหลด…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /กลับ/ }).getAttribute("href")).toBe(`/events/${EVENT_ID}`);
    expect(screen.getByRole("link", { name: /Quick Show/ }).getAttribute("href")).toBe("/my-show");
    expect(screen.queryByTestId("caller")).toBeNull();
  });
});
