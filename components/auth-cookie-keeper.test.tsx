// ---------------------------------------------------------------------------
// AFTER THE PAGE WRITES A TOKEN, THE SERVER RE-SETS IT (2026-10-30, hunt 11)
//
// What used to go wrong: the browser supabase client writes the session cookie by script
// on every refresh, WebKit caps such a cookie at 7 days, and nothing ever sent it back in
// a header - a member whose iPhone sat a week between shows was signed out at the venue.
// AuthCookieKeeper asks POST /api/auth/cookie-keep (which re-sets it for 400 days) right
// after a refresh, after a sign-in, and on load when this token was never kept or the last
// keep is 12 h old - not on every SIGNED_IN auth-js sends on each load / return to the
// foreground, never on sign-out (and a sign-out drops a request still out), never with a
// token about to be refreshed, and one request at a time.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

type Cb = (event: string, session: { expires_at?: number } | null) => void;

const h = vi.hoisted(() => ({ cb: null as Cb | null, unsubscribed: 0 }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (cb: Cb) => {
        h.cb = cb;
        return { data: { subscription: { unsubscribe: () => (h.unsubscribed += 1) } } };
      },
    },
  }),
}));

import { AuthCookieKeeper } from "@/components/auth-cookie-keeper";

const KEPT_KEY = "cueiq:auth-cookie-kept";

/** A fetch whose answers the test hands out one by one. */
let pending: { resolve: (ok: boolean) => void; signal: AbortSignal }[] = [];
const fetchMock = vi.fn((_url: string, init: RequestInit) => {
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    pending.push({
      resolve: (ok) => resolve(new Response("{}", { status: ok ? 200 : 401 })),
      signal,
    });
  });
});

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const emit = (event: string, session: { expires_at?: number } | null) => h.cb!(event, session);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  pending = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  h.cb = null;
  h.unsubscribed = 0;
  render(<AuthCookieKeeper />);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthCookieKeeper", () => {
  it("a token refresh (the page just wrote the cookie by script) asks the server to re-set it", () => {
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/cookie-keep");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("a sign-in with a token this device never kept asks", () => {
    emit("SIGNED_IN", { expires_at: inAnHour() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("on load, an existing session that was never kept asks once", () => {
    emit("INITIAL_SESSION", { expires_at: inAnHour() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no session on load, or a sign-out: nothing is sent", () => {
    emit("INITIAL_SESSION", null);
    emit("SIGNED_OUT", null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the SIGNED_IN auth-js repeats on every load and return to the foreground does not ask again for a token already kept", async () => {
    const exp = inAnHour();
    emit("INITIAL_SESSION", { expires_at: exp });
    pending[0].resolve(true);
    await flush();
    expect(JSON.parse(localStorage.getItem(KEPT_KEY)!).exp).toBe(exp);

    emit("SIGNED_IN", { expires_at: exp }); // tab came back
    emit("INITIAL_SESSION", { expires_at: exp }); // next load
    expect(fetchMock).toHaveBeenCalledTimes(1);

    emit("SIGNED_IN", { expires_at: exp + 3600 }); // another token (a real sign-in / another tab's refresh)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the same kept token is asked again once the last keep is over 12 h old", () => {
    const exp = inAnHour();
    localStorage.setItem(KEPT_KEY, JSON.stringify({ exp, at: Date.now() - 13 * 60 * 60 * 1000 }));
    emit("INITIAL_SESSION", { expires_at: exp });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a refused keep (401) is not remembered, so the next load asks again", async () => {
    const exp = inAnHour();
    emit("INITIAL_SESSION", { expires_at: exp });
    pending[0].resolve(false);
    await flush();
    expect(localStorage.getItem(KEPT_KEY)).toBeNull();
    emit("SIGNED_IN", { expires_at: exp });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("one request at a time", async () => {
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() });
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() + 1 });
    emit("SIGNED_IN", { expires_at: inAnHour() + 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending[0].resolve(true);
    await flush();
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() + 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a sign-out drops a keep still out - its answer would put the cleared cookie back", async () => {
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() });
    const { signal } = pending[0];
    emit("SIGNED_OUT", null);
    expect(signal.aborted).toBe(true);
    await flush();
    expect(localStorage.getItem(KEPT_KEY)).toBeNull();
  });

  it("a token within minutes of its refresh is not sent (a refresh landing mid-request would be overwritten)", () => {
    const soon = Math.floor(Date.now() / 1000) + 120;
    emit("INITIAL_SESSION", { expires_at: soon });
    emit("SIGNED_IN", { expires_at: soon });
    emit("TOKEN_REFRESHED", { expires_at: soon });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unmount unsubscribes and drops a request still out", () => {
    emit("TOKEN_REFRESHED", { expires_at: inAnHour() });
    const { signal } = pending[0];
    cleanup();
    expect(h.unsubscribed).toBe(1);
    expect(signal.aborted).toBe(true);
  });
});
