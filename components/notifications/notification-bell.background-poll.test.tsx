// 2026-11-05 performance pass: the bell polled every 45 s whether or not anyone could see it
// (~80 reads an hour from a tab left in the background all day), asked once more when the
// page was HIDDEN, and asked twice on coming back (focus + visibilitychange). The bell is
// read only on this page (no app badge, no title), so: in front, the same as before;
// hidden, nothing; back in front, one read at once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { NotificationBell } from "@/components/notifications/notification-bell";

let supa: SupabaseFake;
let visibility: DocumentVisibilityState = "visible";
const reads = () => supa.callsTo("notifications", "select").length;
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  supa = makeSupabaseFake({ script: { notifications: ok([]), events: ok([]) } });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // back to jsdom's own getter
  delete (document as { visibilityState?: unknown }).visibilityState;
});

async function mount() {
  await act(async () => {
    render(<NotificationBell userId="u1" tenantId="t1" />);
  });
}
async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("NotificationBell polling", () => {
  it("in front: reads on mount and every 45 s, as before", async () => {
    await mount();
    expect(reads()).toBe(1);
    await wait(45_000);
    expect(reads()).toBe(2);
    await wait(45_000);
    expect(reads()).toBe(3);
  });

  it("hidden: no read on hiding and none on the 45 s ticks", async () => {
    await mount();
    await wait(3_000);
    setVisibility("hidden");
    await wait(45_000 * 4);
    expect(reads()).toBe(1);
  });

  it("back in front: ONE read at once, though focus and visibilitychange both fire", async () => {
    await mount();
    await wait(3_000);
    setVisibility("hidden");
    await wait(60_000);
    setVisibility("visible");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads()).toBe(2);
    // and the interval carries on as before while in front
    await wait(45_000);
    expect(reads()).toBe(3);
  });

  it("a focus long after the last read still reads (a window brought back without a tab change)", async () => {
    await mount();
    await wait(10_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads()).toBe(2);
  });
});
