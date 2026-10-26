// ---------------------------------------------------------------------------
// A FAILED push_subscriptions READ IS NOT "NOBODY HAS A DEVICE".
//
// 2026-10-25 review: pushToUsers coalesced a failed read to [] - 0 pushed, no throw -
// so the reminder cron (its only caller) counted it as a quiet morning: nothing in its
// failures[], nothing in the Dev Inbox, and the bell row was already written, so the
// 20 h dedupe then kept any re-run from pushing it. It must reach the caller.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: string[] = [];
vi.mock("@/lib/push", () => ({
  PUSH_TTL_SECONDS: { live: 3 * 3600, reminder: 12 * 3600, default: 3 * 24 * 3600 },
  vapidConfigured: () => true,
  sendPush: async (s: { endpoint: string }) => {
    sent.push(s.endpoint);
    return "ok" as const;
  },
}));

import { pushToUsers } from "./notify-server";

/** One awaitable chain that always answers `answer`. */
function adminWith(answer: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "delete"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, bad);
  return { from: () => q } as never;
}

const payload = { title: "📅 โชว์วันนี้", body: "x", link: "/events/e1" };

beforeEach(() => {
  sent.length = 0;
});

describe("pushToUsers", () => {
  it("a failed push_subscriptions read is an error the caller sees, not 0 sent", async () => {
    await expect(
      pushToUsers(
        adminWith({ data: null, error: { message: "canceling statement due to statement timeout" } }),
        ["u1", "u2"],
        payload
      )
    ).rejects.toThrow(/statement timeout/);
    expect(sent).toEqual([]);
  });

  it("a read that worked pushes to every device", async () => {
    const n = await pushToUsers(
      adminWith({
        data: [{ id: "s1", endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "p", auth: "a" }],
        error: null,
      }),
      ["u1"],
      payload
    );
    expect(n).toBe(1);
    expect(sent).toEqual(["https://fcm.googleapis.com/fcm/send/abc"]);
  });

  it("nobody with a device is still 0, without an error", async () => {
    await expect(pushToUsers(adminWith({ data: [], error: null }), ["u1"], payload)).resolves.toBe(0);
  });
});
