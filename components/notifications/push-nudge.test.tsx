// The prompt that exists because a measurement said it had to.
//
// On 2026-08-31 `push_subscriptions` held ONE row out of nineteen accounts. The
// plumbing was fine — 148 reminders written, /api/notify working, VAPID live — but
// the only switch was inside the bell dropdown, so eighteen people never found it.
// That is why a bug report sat unanswered for two months: the messages were being
// written and nobody was being told.
//
// The restraint is the part worth testing. A banner that interrupts a show gets
// dismissed on reflex, and then the real ones are too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { setLiveShowActive } from "@/lib/live-guard";

const h = vi.hoisted(() => ({
  availability: vi.fn<() => Promise<string>>(async () => "available"),
  enable: vi.fn<() => Promise<{ ok: boolean; reason?: string; message?: string }>>(
    async () => ({ ok: true })
  ),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/push-subscribe", () => ({
  pushAvailability: h.availability,
  enablePush: h.enable,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { PushNudge } from "@/components/notifications/push-nudge";

const ME = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const DISMISS_KEY = "cueiq:push-nudge-dismissed";

/** Run past the delay and let the availability promise settle. */
async function elapse() {
  await act(async () => {
    vi.advanceTimersByTime(9000);
  });
  await flush();
}

/** Drain the microtask queue. Testing Library's async helpers poll on REAL
 *  timers, which the fake clock in this file has frozen, so one would sit until
 *  the 5s test timeout even though every mocked promise resolved immediately. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  return render(<PushNudge userId={ME} tenantId={TENANT} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  setLiveShowActive(false);
  h.availability.mockResolvedValue("available");
  h.enable.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
  setLiveShowActive(false);
  cleanup();
});

describe("PushNudge", () => {
  it("asks, once the page has settled", async () => {
    mount();
    // Not immediately — it must not land on a page someone is still reading.
    expect(screen.queryByTestId("push-nudge")).toBeNull();
    await elapse();
    expect(screen.getByTestId("push-nudge")).toBeInTheDocument();
  });

  // THE ONE THAT MATTERS. An operator running a set must never have anything
  // appear over the show, and a prompt they swat away teaches them to swat away
  // the next one, which might be real.
  it("NEVER appears while a show is running", async () => {
    setLiveShowActive(true);
    mount();
    await elapse();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
  });

  it("also stays away if the show starts DURING the delay", async () => {
    mount();
    setLiveShowActive(true); // …between mount and the timer firing
    await elapse();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
  });

  it.each(["unsupported", "denied", "on"])(
    "stays silent when availability is %s",
    async (state) => {
      h.availability.mockResolvedValue(state);
      mount();
      await elapse();
      expect(screen.queryByTestId("push-nudge")).toBeNull();
    }
  );

  it("does not ask a device that already said ไว้ก่อน", async () => {
    localStorage.setItem(DISMISS_KEY, "1");
    mount();
    await elapse();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
    // …and it did not even bother asking the browser.
    expect(h.availability).not.toHaveBeenCalled();
  });

  it("remembers ไว้ก่อน per device, so it is asked once and not again", async () => {
    mount();
    await elapse();
    fireEvent.click(screen.getByText("ไว้ก่อน"));
    expect(screen.queryByTestId("push-nudge")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("subscribes on เปิดเลย and says so", async () => {
    mount();
    await elapse();
    fireEvent.click(screen.getByText("เปิดเลย"));
    await flush();
    expect(h.enable).toHaveBeenCalledTimes(1);
    expect(h.enable).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ME, tenantId: TENANT })
    );
    await flush();
    expect(h.success).toHaveBeenCalled();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
  });

  it("points at the bell when the browser prompt is refused, and stops asking", async () => {
    h.enable.mockResolvedValue({ ok: false, reason: "denied" });
    mount();
    await elapse();
    fireEvent.click(screen.getByText("เปิดเลย"));
    await flush();
    expect(h.error).toHaveBeenCalled();
    expect(h.error.mock.calls[0][1]).toMatchObject({
      description: expect.stringContaining("กระดิ่ง"),
    });
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("closes even when subscribing fails, rather than nagging every visit", async () => {
    h.enable.mockResolvedValue({ ok: false, reason: "failed", message: "boom" });
    mount();
    await elapse();
    fireEvent.click(screen.getByText("เปิดเลย"));
    await flush();
    expect(h.error).toHaveBeenCalled();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  // A private window throws on localStorage. Silent is the safe direction: a
  // banner nobody can dismiss would be worse than no banner at all.
  it("stays silent when this browser refuses storage entirely", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    mount();
    await elapse();
    expect(screen.queryByTestId("push-nudge")).toBeNull();
    spy.mockRestore();
  });
});
