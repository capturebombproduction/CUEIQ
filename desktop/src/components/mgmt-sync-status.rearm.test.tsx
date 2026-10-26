// The management outbox used to get ONE attempt per boot /
// 'online' event. components/outbox-flusher.tsx learned (and fixed, for the show-run and
// running-order queues) that this attempt lands in the minute supabase-js still signs as
// anon - and a venue AP that stays "associated" never fires 'online' at all. The mgmt queue
// was left on the old triggers: once its first attempt does nothing, a queued setlist /
// schedule / mic snapshot waits for a reboot or a hand on the amber chip, while every later
// edit writes straight to the server on top of it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const m = vi.hoisted(() => ({ flushes: 0, pending: 1 }));
vi.mock("~/data/mgmt-outbox", () => ({
  MGMT_OUTBOX_EVENT: "cueiq:mgmt-outbox-change",
  flushMgmtOutbox: vi.fn(async () => {
    m.flushes++;
    // what doFlush answers when requireLiveSession() threw on the first op
    return { flushed: 0, parked: 0, remaining: 1 };
  }),
  listMgmtConflicts: vi.fn(async () => []),
  pendingMgmtCount: vi.fn(async () => m.pending),
  resolveMgmtConflict: vi.fn(),
}));

import { MgmtSyncStatus } from "~/components/mgmt-sync-status";

beforeEach(() => {
  m.flushes = 0;
  m.pending = 1;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("MgmtSyncStatus — a queue whose first flush did nothing", () => {
  it("is tried again while the app stays open (foreground / timer), like the other two queues", async () => {
    render(<MgmtSyncStatus headless />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(m.flushes).toBe(1); // boot attempt
    // the operator keeps working for two minutes, switches windows and back
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(m.flushes).toBeGreaterThan(1);
  });

  it("an empty queue is left alone by the timer", async () => {
    m.pending = 0;
    render(<MgmtSyncStatus headless />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(m.flushes).toBe(1); // the boot attempt only
  });
});
