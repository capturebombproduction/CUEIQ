import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// notify() is fire-and-forget: web posts same-origin with the cookie session;
// desktop (CUEIQ_WEB_ORIGIN defined) posts to the web origin with a Bearer
// token. These tests pin that seam + the never-throws contract.

const getSession = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession } }),
}));

import { notify } from "./notify-client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true });
  getSession.mockReset().mockResolvedValue({ data: { session: null } });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("notify (web: no CUEIQ_WEB_ORIGIN)", () => {
  it("posts same-origin to /api/notify without an Authorization header", async () => {
    notify("event_submitted", { eventId: "ev1" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/notify");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ kind: "event_submitted", eventId: "ev1" });
    // the cookie session authorizes the web path — no session lookup needed
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("notify (desktop: CUEIQ_WEB_ORIGIN defined)", () => {
  beforeEach(() => {
    vi.stubEnv("CUEIQ_WEB_ORIGIN", "https://cueiq.example");
  });

  it("posts to the web origin with a Bearer token from the session", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
    notify("run_order_live", { eventId: "ev2" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cueiq.example/api/notify");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer tok-123",
    });
    expect(JSON.parse(init.body)).toEqual({ kind: "run_order_live", eventId: "ev2" });
  });

  it("still posts (without Authorization) when no session exists", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    notify("song_cleared", { songId: "s1" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cueiq.example/api/notify");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("never throws into the caller when the session lookup or fetch fails", async () => {
    getSession.mockRejectedValue(new Error("offline"));
    expect(() => notify("song_pending", { songId: "s2" })).not.toThrow();
    // let the swallowed rejection settle — an unhandled rejection would fail the run
    await new Promise((r) => setTimeout(r, 0));

    getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(() => notify("song_pending", { songId: "s2" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
