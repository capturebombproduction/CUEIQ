// THE CAPTURE PATH HAD NEVER BEEN TESTED, AND THAT IS WHY WE COULD NOT READ ITS
// SILENCE.
//
// On 2026-09-04 `client_errors` held zero rows for the entire life of the app —
// 39 shows in 90 days, 19 accounts. The code and its RLS both look right, and the
// IGNORE list drops the classes that would otherwise dominate (hydration,
// ResizeObserver, "Failed to fetch"), so zero is plausibly honest. But
// logClientError swallows every failure of its own BY DESIGN, so nothing outside
// it could ever tell a healthy silence from a blind one.
//
// These tests are what makes the silence readable: if the path works here, then
// zero rows means zero errors. That is the entire point of the file.
//
// `.dom.` because logClientError reads `location`, `navigator` and `atob`-adjacent
// browser globals — run in the node project it would take its own "no browser"
// branches and pass while asserting nothing.
/**
 * ⚠️ THE URL IS PART OF THE TEST. jsdom defaults to http://localhost, and
 * isDevOrigin() drops anything from localhost on purpose — our own debugging is
 * not a user hitting a production problem. Written without this, every "it stores
 * the row" case silently took the dev-origin branch and asserted nothing.
 *
 * @vitest-environment-options { "url": "https://cueiq-mu.vercel.app/dashboard" }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  insert: vi.fn<(row: Record<string, unknown>) => Promise<{ error: unknown }>>(
    async () => ({ error: null })
  ),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ insert: h.insert }) }),
}));

import { logClientError } from "@/lib/client-log";

const ME = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

/** A fresh message each time — the module dedupes on `kind:message` for the life
 *  of the session and there is no reset, which is itself correct behaviour. */
let n = 0;
const uniq = () => `boom ${Date.now()}-${n++}`;

function log(over: Partial<Parameters<typeof logClientError>[0]> = {}) {
  return logClientError({
    userId: ME,
    tenantId: TENANT,
    kind: "error",
    message: uniq(),
    url: "https://cueiq-mu.vercel.app/dashboard",
    ...over,
  });
}

beforeEach(() => {
  h.insert.mockClear();
  h.insert.mockResolvedValue({ error: null });
});

describe("logClientError — the path actually reaches the table", () => {
  it("writes the row, and says it did", async () => {
    await expect(log({ message: "a real crash" })).resolves.toBe(true);
    expect(h.insert).toHaveBeenCalledTimes(1);
    const row = h.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      user_id: ME,
      tenant_id: TENANT,
      kind: "error",
      message: "a real crash",
    });
    // app_version is what tells us WHICH build a report came from.
    expect(row.app_version).toBeDefined();
  });

  // The reason this function's return type changed. Something downstream tells a
  // user "ระบบบันทึกปัญหานี้ไว้ให้แล้ว" at the worst moment of their day.
  it("reports FALSE when the insert is refused, without throwing", async () => {
    h.insert.mockResolvedValue({ error: { message: "new row violates RLS" } });
    await expect(log()).resolves.toBe(false);
  });

  it("reports FALSE when the request throws outright, without throwing", async () => {
    h.insert.mockRejectedValue(new Error("offline"));
    await expect(log()).resolves.toBe(false);
  });

  it("truncates a huge message and stack rather than refusing the row", async () => {
    await log({ message: "x".repeat(5000), stack: "y".repeat(20000) });
    const row = h.insert.mock.calls[0][0] as { message: string; stack: string };
    expect(row.message.length).toBe(2000);
    expect(row.stack.length).toBe(6000);
  });
});

describe("what it deliberately drops — the reason zero rows can be honest", () => {
  it.each([
    ["ResizeObserver loop completed with undelivered notifications"],
    ["Script error."],
    ["Failed to fetch"],
    ["Load failed"],
    ["Minified React error #418; visit https://react.dev/..."],
    ["Hydration failed because the initial UI does not match"],
    ["Text content does not match server-rendered HTML"],
  ])("ignores browser noise: %s", async (message) => {
    await expect(log({ message })).resolves.toBe(false);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("ignores an empty message", async () => {
    await expect(log({ message: "   " })).resolves.toBe(false);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("ignores our own local debugging", async () => {
    await expect(
      log({ url: "webpack-internal:///./app/page.tsx", message: uniq() })
    ).resolves.toBe(false);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("stores the same error only once per session", async () => {
    const message = uniq();
    await expect(log({ message })).resolves.toBe(true);
    await expect(log({ message })).resolves.toBe(false);
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  // A crash loop must not turn one bad render into a thousand rows.
  it("stops after the per-session cap", async () => {
    for (let i = 0; i < 40; i++) await log();
    expect(h.insert.mock.calls.length).toBeLessThanOrEqual(12);
    await expect(log()).resolves.toBe(false);
  });
});
