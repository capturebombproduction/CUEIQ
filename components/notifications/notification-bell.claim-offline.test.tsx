// 2026-10-27 hunt (overview), a regression of c4388cf: claimPushSubscription read a network
// failure as "the row is someone else's" - supabase-js answers a dead request with
// { error, status: 0 }, it never throws - and the bell then UNSUBSCRIBED the member's own
// phone on venue wifi. Only an RLS refusal (42501 / 403) gives the subscription up.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { makeSupabaseFake, ok, offline, fail, makeSession, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY =
    "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
  return { supa: null as unknown };
});
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { NotificationBell } from "@/components/notifications/notification-bell";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/my-own-phone";
const ME = "user-me";

let supa: SupabaseFake;
let unsubscribe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      notifications: ok([]),
      events: ok([]),
      // venue wifi: the claim's upsert never reaches the server
      push_subscriptions: offline(),
    },
    session: makeSession(),
  });
  h.supa = supa;
  unsubscribe = vi.fn(async () => true);
  const sub = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: null },
    unsubscribe,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
  };
  const reg = { pushManager: { getSubscription: vi.fn(async () => sub), subscribe: vi.fn() } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission: "granted",
    requestPermission: vi.fn(async () => "granted"),
  };
});

describe("NotificationBell — the push claim on a dead network", () => {
  it("does not kill MY OWN device's push subscription when the claim upsert could not reach the server", async () => {
    await act(async () => {
      render(<NotificationBell userId={ME} tenantId="t1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(supa.callsTo("push_subscriptions").some((c) => c.verb === "upsert")).toBe(true);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("a real RLS refusal (the row is another account's) still gives the subscription up", async () => {
    supa.setTable("push_subscriptions", fail({ message: "new row violates row-level security policy", code: "42501" }, 403));
    await act(async () => {
      render(<NotificationBell userId={ME} tenantId="t1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
