// 2026-10-30, hunt 12: "เตรียม" on a full disk ran its bar to the end and the card still read "not
// ready", with no reason; pressing again repeated the 88 MB downloads. It says so now.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { LocalOnlyCandidate, PrefetchTarget } from "@/lib/audio-targets";

const h = vi.hoisted(() => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() },
  result: { totalTargets: 1, fetched: 0, skipped: 0, failed: 1, removedStale: 0, noRoom: true },
}));
vi.mock("sonner", () => ({ toast: h.toast, Toaster: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/audio-prefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio-prefetch")>()),
  prefetchEventAudio: vi.fn(async () => h.result),
}));

import { ShowReadinessCheck } from "./show-readiness-check";

const TARGETS: PrefetchTarget[] = [{ itemId: "a", path: "t/g/a.wav", name: "a.wav" }];
const NONE: LocalOnlyCandidate[] = [];

async function press() {
  render(<ShowReadinessCheck eventId="ev-prep" targets={TARGETS} localOnly={NONE} />);
  const btn = await screen.findByRole("button", { name: /เตรียม 1 เพลง/ });
  await act(async () => void fireEvent.click(btn));
}

describe("ShowReadinessCheck · a prepare that left files behind", () => {
  beforeEach(() => h.toast.error.mockClear());

  it("says the disk is full", async () => {
    h.result = { ...h.result, failed: 1, noRoom: true };
    await press();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    expect(h.toast.error.mock.calls[0][1].description).toContain("พื้นที่ในเครื่องเต็ม");
  });

  it("says nothing when every file landed", async () => {
    h.result = { ...h.result, failed: 0, noRoom: false };
    await press();
    expect(h.toast.error).not.toHaveBeenCalled();
  });
});
