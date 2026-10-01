import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP SHELL, AFTER THE REDESIGN (FINAL-SPEC-v2 §F.3 / §F.4).
//
// The desktop is the copy that goes to the venue, and it carried the same floating
// แจ้งปัญหา button as the web. Product decision (round 2): no floating feedback
// button anywhere. Reporting is the Feedback tile in the account panel, which the
// desktop opens from its header avatar (it has no tab bar). Also pinned: the
// immersive Live screens get no header, and the attributes the .exe self-test reads
// (data-cueiq-screen / data-cueiq-tenant) survive the new frame.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
// Its own subject (the offline outbox chips) with its own IndexedDB; a marker here.
vi.mock("~/components/mgmt-sync-status", () => ({
  MgmtSyncStatus: () => <span data-testid="mgmt-sync" />,
}));
vi.mock("@/components/outbox-flusher", () => ({ OutboxFlusher: () => null }));

const PERMS = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
const WS = {
  user: { id: "u1", email: "seishin-mem@cueiq.local", name: "มายด์" },
  membership: { tenant_id: "t1", role: "member" as const },
  tenant: { id: "t1", name: "A Lot Of Tone" },
  groups: [{ id: "g1", name: "Seishin Kakumei" }],
  groupRoles: [{ group_id: "g1", role: "member" }],
  perms: PERMS,
};
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: WS, reload: () => {} }),
}));

import { Shell } from "./shell";

async function at(path: string) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<div data-testid="page" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  });
}

beforeEach(() => {
  h.supa = makeSupabaseFake({ script: { feedback: ok([]) } });
  localStorage.setItem("cueiq:whats-new-seen", "2026-10-01");
});

describe("desktop Shell — feedback", () => {
  it("renders NO floating feedback button — the page has nothing titled แจ้งปัญหา until the panel opens", async () => {
    await at("/dashboard");
    expect(screen.queryByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeNull();
    expect(screen.queryByText("แจ้งปัญหา")).toBeNull();
  });

  it("reports from the account panel, opened by the header avatar", async () => {
    await at("/dashboard");
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "เมนูบัญชี" }));
    const panel = screen.getByTestId("account-panel");
    expect(within(panel).getByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "ออกจากระบบ" })).toBeTruthy();
    // The inline nav already lists the destinations; the panel does not repeat them.
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
  });
});

describe("desktop Shell — frame", () => {
  it("one header: wordmark, the inline nav, Quick Show, the account avatar — and no tab bar", async () => {
    await at("/dashboard");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "CueIQ" })).toBeTruthy();
    expect(within(header).getByRole("navigation", { name: "เมนูหลัก" })).toBeTruthy();
    expect(within(header).getByRole("link", { name: /Quick Show/ })).toBeTruthy();
    expect(screen.queryByTestId("tab-bar")).toBeNull();
  });

  it("keeps the self-test's attributes on the frame", async () => {
    await at("/dashboard");
    const frame = document.querySelector('[data-cueiq-screen="shell"]');
    expect(frame?.getAttribute("data-cueiq-tenant")).toBe("A Lot Of Tone");
    expect(frame?.className).toContain("[--tabbar-h:0px]");
  });

  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s is immersive: no header, the page still renders",
    async (path) => {
      await at(path);
      expect(screen.queryByRole("banner")).toBeNull();
      expect(screen.getByTestId("page")).toBeTruthy();
      expect(document.querySelector('[data-cueiq-screen="shell"]')).toBeTruthy();
    }
  );
});
