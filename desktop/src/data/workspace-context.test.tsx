// The workspace provider between loadWorkspace and the Shell. 2026-10-24: a first launch
// with no network now rejects with COLD_OFFLINE (it used to resolve an empty workspace and
// every page said "บัญชีนี้ยังไม่ได้ผูกกับ Label"); the provider has to tell that apart from
// any other failure, and fill in by itself once the wifi joins.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("~/data/workspace", async (orig) => ({
  ...(await orig<typeof import("~/data/workspace")>()),
  loadWorkspace: h.load,
}));

import { COLD_OFFLINE } from "~/data/workspace";
import { WorkspaceProvider, useWorkspace } from "./workspace-context";

function Probe() {
  const { loading, ws, coldOffline } = useWorkspace();
  return (
    <p data-testid="probe">
      {loading ? "loading" : ws ? `ws:${ws.user?.id}` : coldOffline ? "cold" : "failed"}
    </p>
  );
}

const probe = () => screen.getByTestId("probe").textContent;
const WS = { user: { id: "u1", email: null, name: null } };

beforeEach(() => {
  h.load.mockReset();
});

describe("WorkspaceProvider", () => {
  it("marks a COLD_OFFLINE rejection as cold, any other as a plain failure", async () => {
    h.load.mockRejectedValueOnce(new Error(COLD_OFFLINE));
    const a = render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await waitFor(() => expect(probe()).toBe("cold"));
    a.unmount();

    h.load.mockRejectedValueOnce(new Error("workspace: the membership read failed"));
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await waitFor(() => expect(probe()).toBe("failed"));
  });

  it("loads again by itself when the network comes back", async () => {
    h.load.mockRejectedValueOnce(new Error(COLD_OFFLINE)).mockResolvedValueOnce(WS);
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await waitFor(() => expect(probe()).toBe("cold"));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(probe()).toBe("ws:u1"));
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("does not reload on 'online' once the workspace is there", async () => {
    h.load.mockResolvedValue(WS);
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await waitFor(() => expect(probe()).toBe("ws:u1"));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(h.load).toHaveBeenCalledTimes(1);
  });
});
