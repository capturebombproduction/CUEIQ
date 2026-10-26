import { describe, expect, it, vi, beforeEach } from "vitest";

// 2026-10-27 hunt 6: every Web Push went out with web-push's DEFAULT TTL (4 weeks), so a
// "🔴 งานเริ่มแล้ว" / "📅 โชว์วันนี้" sent to a phone that was off or in airplane mode through
// the show buzzed whenever it came back - the next day, for a show already over.
const sendNotification = vi.fn<(...args: unknown[]) => Promise<{ statusCode: number }>>(async () => ({ statusCode: 201 }));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) },
}));

const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "p", auth: "a" };
const ttlOf = (call: number) => (sendNotification.mock.calls[call][2] as { TTL?: number } | undefined)?.TTL;

describe("sendPush: a push never outlives its news", () => {
  beforeEach(() => {
    process.env.VAPID_PRIVATE_KEY = "x";
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "y";
    sendNotification.mockClear();
  });

  it("sends a bounded TTL by default (never web-push's 4 weeks)", async () => {
    const { sendPush, PUSH_TTL_SECONDS } = await import("@/lib/push");
    expect(await sendPush(sub, { title: "t", body: "", link: "/" })).toBe("ok");
    expect(ttlOf(0)).toBe(PUSH_TTL_SECONDS.default);
    expect(PUSH_TTL_SECONDS.default).toBeLessThanOrEqual(3 * 24 * 3600);
  });

  it("the show-went-live push and the morning reminders expire within the day", async () => {
    const { sendPush, PUSH_TTL_SECONDS } = await import("@/lib/push");
    await sendPush(sub, { title: "🔴 งานเริ่มแล้ว (Live)", body: "", link: "/overview" }, PUSH_TTL_SECONDS.live);
    expect(ttlOf(0)).toBeLessThanOrEqual(3 * 3600);
    expect(PUSH_TTL_SECONDS.reminder).toBeLessThanOrEqual(12 * 3600);
  });

  it("pushToUsers (the cron's fan-out) passes its TTL down to every device", async () => {
    const { pushToUsers } = await import("@/lib/notify-server");
    const admin = {
      from: () => ({
        select: () => ({ in: async () => ({ data: [{ id: "s1", ...sub }, { id: "s2", ...sub }], error: null }) }),
      }),
    };
    const sent = await pushToUsers(admin as never, ["u1"], { title: "📅 โชว์วันนี้", body: "", link: "/" }, 12 * 3600);
    expect(sent).toBe(2);
    expect([ttlOf(0), ttlOf(1)]).toEqual([12 * 3600, 12 * 3600]);
  });
});
