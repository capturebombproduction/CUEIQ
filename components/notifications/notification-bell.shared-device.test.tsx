// The bell used to say push is ON for
// whoever is signed in, from the browser's subscription alone.
//
// notification-bell.tsx:255-288 decides "on" from reg.pushManager.getSubscription()
// (+ the VAPID key match) and never looks at, or re-saves, the push_subscriptions row
// the server actually sends to. On a shared band iPad the row for that endpoint still
// belongs to the PREVIOUS account whenever their session ended without the sign-out
// button (the session died / was revoked while the app was closed, or on the Live
// screen where ChromeGate unmounts the bell and its SIGNED_OUT listener): the next
// person signs in, the bell shows "เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว", the push nudge
// stays silent (pushAvailability() = "on"), their own reminders never arrive - and the
// previous account's ("โชว์พรุ่งนี้", "งานรออนุมัติ") pop up on this device instead.
// enablePush's shared-device retry (lib/push-subscribe.ts) is never reached, because
// nothing offers the button.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { makeSupabaseFake, ok, makeSession, type SupabaseFake } from "@/test/fakes/supabase";

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

const ENDPOINT = "https://web.push.apple.com/QAbc-shared-ipad";
const PREVIOUS = "user-previous-band-member";
const ME = "user-signed-in-now";

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      notifications: ok([]),
      events: ok([]),
      // the server's view of this device: the row is the previous account's
      push_subscriptions: ok([{ endpoint: ENDPOINT, user_id: PREVIOUS }]),
    },
    session: makeSession(),
  });
  h.supa = supa;
  const sub = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: null }, // older Safari: key not reported back
    unsubscribe: vi.fn(async () => true),
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

describe("shared device: the bell's push state vs the row the server uses", () => {
  it("does not tell the new account push is on when this device's subscription is saved for someone else", async () => {
    await act(async () => {
      render(<NotificationBell userId={ME} tenantId="t1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /การแจ้งเตือน/ }));
    });
    // Either re-bind the subscription to ME (an upsert carrying my user id) or offer
    // the enable button - never a confident "on" for pushes that go to another account.
    const reboundToMe = supa
      .callsTo("push_subscriptions")
      .some((c) => (c.verb === "upsert" || c.verb === "insert") && (c.values as { user_id?: string })?.user_id === ME);
    const claimsOn = !!screen.queryByText(/เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว/);
    expect(reboundToMe || !claimsOn).toBe(true);
  });
});
