// public/sw.js notificationclick vs a window that is running the show.
//
// Tapping a push used to focus the FIRST window client and navigate it to the
// link. On an installed PWA that is the only window - the Live page - and the
// navigate unloads it: Live Mode's <audio> dies, silence mid-set. Live Mode's
// leave-guard can't see a SW navigate and iOS ignores beforeunload, so the worker
// itself must never navigate a Live / show-caller / practice window.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";

type Handler = (e: unknown) => void;
const ORIGIN = "https://cueiq-mu.vercel.app";

function loadSw(clients: unknown[]) {
  const handlers: Record<string, Handler> = {};
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    location: { origin: ORIGIN },
    clients: {
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async () => null),
      claim: vi.fn(async () => {}),
    },
    registration: { showNotification: vi.fn(async () => {}) },
    skipWaiting: vi.fn(),
  };
  const src = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", src)(self, { keys: async () => [], delete: async () => true });
  return { self, handlers };
}

async function click(handlers: Record<string, Handler>, link: string) {
  let done: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({
    notification: { close: () => {}, data: { link } },
    waitUntil: (p: Promise<unknown>) => {
      done = p;
    },
  });
  await done;
}

const win = (p: string) => ({
  url: ORIGIN + p,
  focus: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
});

const EVENT = "/events/11111111-1111-4111-8111-111111111111";

describe("sw.js notificationclick never navigates the show away", () => {
  it.each([`${EVENT}/live`, `${EVENT}/run-order/live`, `${EVENT}/practice`])(
    "the only window on %s is focused, not navigated",
    async (page) => {
      const w = win(page);
      const { self, handlers } = loadSw([w]);
      // e.g. the "🔴 งานเริ่มแล้ว" push every account gets the minute the board starts
      await click(handlers, "/events/22222222-2222-4222-8222-222222222222/run-order/live");
      expect(w.navigate).not.toHaveBeenCalled();
      expect(w.focus).toHaveBeenCalled();
      expect(self.clients.openWindow).not.toHaveBeenCalled();
    }
  );

  it("another, ordinary window takes the link while the Live window keeps playing", async () => {
    const live = win(`${EVENT}/live`);
    const other = win("/dashboard");
    const { handlers } = loadSw([live, other]);
    await click(handlers, "/overview");
    expect(live.navigate).not.toHaveBeenCalled();
    expect(other.navigate).toHaveBeenCalledWith(`${ORIGIN}/overview`);
  });

  it("a window already on the link is just focused", async () => {
    const live = win(`${EVENT}/run-order/live`);
    const { handlers } = loadSw([win("/dashboard"), live]);
    await click(handlers, `${EVENT}/run-order/live`);
    expect(live.focus).toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it("an ordinary page is still navigated to the link", async () => {
    const page = win("/dashboard");
    const { handlers } = loadSw([page]);
    await click(handlers, "/overview");
    expect(page.navigate).toHaveBeenCalledWith(`${ORIGIN}/overview`);
  });

  it("the event page itself (not live) is an ordinary page", async () => {
    const page = win(EVENT);
    const { handlers } = loadSw([page]);
    await click(handlers, "/overview");
    expect(page.navigate).toHaveBeenCalledWith(`${ORIGIN}/overview`);
  });

  it("no window at all → opens one", async () => {
    const { self, handlers } = loadSw([]);
    await click(handlers, "/overview");
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/overview`);
  });
});
