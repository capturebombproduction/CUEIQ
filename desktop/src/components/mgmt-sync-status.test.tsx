import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// ─────────────────────────────────────────────────────────────────────────────
// MgmtSyncStatus — the management outbox's ONLY auto-flusher (boot + every
// 'online'). The shell mounts it headless on the immersive screens (Live Mode and
// the show-caller have no header), so the headless form must keep exactly the same
// side effects and draw nothing. The outbox itself is its own subject; mocked here.
// ─────────────────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  flush: vi.fn(async () => ({ flushed: 0, remaining: 0, parked: 0 })),
  pending: vi.fn(async () => 2),
  conflicts: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/data/mgmt-outbox", () => ({
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox",
  flushMgmtOutbox: m.flush,
  listMgmtConflicts: m.conflicts,
  pendingMgmtCount: m.pending,
  resolveMgmtConflict: vi.fn(),
}));

import { MgmtSyncStatus } from "./mgmt-sync-status";

beforeEach(() => {
  m.flush.mockClear();
  m.pending.mockClear();
  m.conflicts.mockClear();
});

describe("MgmtSyncStatus", () => {
  it("default: flushes on mount and shows the pending chip", async () => {
    await act(async () => {
      render(<MgmtSyncStatus />);
    });
    expect(m.flush).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ค้างซิงค์ 2/)).toBeTruthy();
  });

  it("headless: flushes on mount AND whenever the network returns, and draws nothing", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<MgmtSyncStatus headless />));
    });
    expect(m.flush).toHaveBeenCalledTimes(1); // boot
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(m.flush).toHaveBeenCalledTimes(2); // the network came back
    // Pending > 0, yet no chip: the immersive screens carry no header chrome.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/ค้างซิงค์/)).toBeNull();
  });

  it("headless: stops listening once unmounted", async () => {
    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<MgmtSyncStatus headless />));
    });
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(m.flush).toHaveBeenCalledTimes(1);
  });
});
