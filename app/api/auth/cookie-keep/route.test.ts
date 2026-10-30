// ---------------------------------------------------------------------------
// THE SESSION COOKIE COMES BACK IN A HEADER, SO WEBKIT KEEPS IT 400 DAYS (2026-10-30, hunt 11)
//
// What used to go wrong: WebKit (Safari + iPhone home-screen apps) caps a cookie written
// by document.cookie at 7 days. The browser supabase client writes the session that way
// on every refresh, and the proxy re-sent nothing on a signed-in page load with a valid
// token - so a show day ended on a script write, and a member whose phone sat a week met
// /login at the venue. POST /api/auth/cookie-keep sends the cookie back in Set-Cookie,
// value untouched, with @supabase/ssr's own defaults; a refresh the route itself made is
// answered with the library's cookies only; no session writes nothing.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type SetCookie = { name: string; value: string; options: Record<string, unknown> };

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  /** what the library writes while reading the user (a refresh, or removals) */
  libraryWrites: null as SetCookie[] | null,
  /** the cookies the route handed the library */
  seen: [] as { name: string; value: string }[],
}));

vi.mock("@supabase/ssr", async (importOriginal) => {
  const real = await importOriginal<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (
      _url: string,
      _key: string,
      opts: {
        cookies: {
          getAll: () => { name: string; value: string }[];
          setAll: (c: SetCookie[]) => void;
        };
      }
    ) => ({
      auth: {
        getUser: async () => {
          h.seen = opts.cookies.getAll();
          if (h.libraryWrites) opts.cookies.setAll(h.libraryWrites);
          return { data: { user: h.user }, error: h.user ? null : { message: "no session" } };
        },
      },
    }),
  };
});
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://x.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

import { POST } from "./route";

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

function keepRequest(cookie: string) {
  return new NextRequest("https://cueiq-mu.vercel.app/api/auth/cookie-keep", {
    method: "POST",
    headers: { cookie },
  });
}

const SIGNED_IN_COOKIES = [
  "sb-x-auth-token.0=base64-eyJhY2Nlc3NfdG9rZW4iOiJ2MSJ9",
  "sb-x-auth-token.1=LXBhcnQtdHdv",
  "sb-x-auth-token-code-verifier=base64-dmVyaWZpZXI",
  "cueiq-other=1",
].join("; ");

beforeEach(() => {
  h.user = null;
  h.libraryWrites = null;
  h.seen = [];
});

describe("POST /api/auth/cookie-keep", () => {
  it("a signed-in request with a valid token gets every session cookie chunk back in Set-Cookie, unchanged, 400 days, readable by the page", async () => {
    h.user = { id: "u1" };
    const res = await POST(keepRequest(SIGNED_IN_COOKIES));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const set = res.cookies.getAll();
    expect(set.map((c) => c.name).sort()).toEqual(["sb-x-auth-token.0", "sb-x-auth-token.1"]);
    for (const c of set) {
      expect(c.maxAge).toBe(FOUR_HUNDRED_DAYS);
      expect(c.path).toBe("/");
      expect(c.sameSite).toBe("lax");
      expect(c.httpOnly).toBeFalsy();
    }
    expect(set.find((c) => c.name === "sb-x-auth-token.0")?.value).toBe(
      "base64-eyJhY2Nlc3NfdG9rZW4iOiJ2MSJ9"
    );
    expect(set.find((c) => c.name === "sb-x-auth-token.1")?.value).toBe("LXBhcnQtdHdv");

    // the raw header: no HttpOnly (the browser client must keep reading it), never the
    // PKCE verifier, nothing that is not the session
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toMatch(/sb-x-auth-token\.0=base64-eyJhY2Nlc3NfdG9rZW4iOiJ2MSJ9/);
    expect(raw).toMatch(/Max-Age=34560000/i);
    expect(raw).not.toMatch(/HttpOnly/i);
    expect(raw).not.toMatch(/code-verifier/);
    expect(raw).not.toMatch(/cueiq-other/);
  });

  it("an unchunked session cookie is kept too", async () => {
    h.user = { id: "u1" };
    const res = await POST(keepRequest("sb-abc-auth-token=base64-eyJ4IjoxfQ"));
    expect(res.cookies.getAll().map((c) => [c.name, c.value, c.maxAge])).toEqual([
      ["sb-abc-auth-token", "base64-eyJ4IjoxfQ", FOUR_HUNDRED_DAYS],
    ]);
  });

  it("when reading the user refreshed the token, only the library's cookies go back - the old value is never echoed over them", async () => {
    h.user = { id: "u1" };
    h.libraryWrites = [
      {
        name: "sb-x-auth-token.0",
        value: "base64-eyJhY2Nlc3NfdG9rZW4iOiJ2MiJ9",
        options: { path: "/", sameSite: "lax", httpOnly: false, maxAge: FOUR_HUNDRED_DAYS },
      },
      {
        name: "sb-x-auth-token.1",
        value: "",
        options: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 0 },
      },
    ];
    const res = await POST(keepRequest(SIGNED_IN_COOKIES));
    expect(res.status).toBe(200);
    const set = res.cookies.getAll();
    expect(set.map((c) => [c.name, c.value, c.maxAge])).toEqual([
      ["sb-x-auth-token.0", "base64-eyJhY2Nlc3NfdG9rZW4iOiJ2MiJ9", FOUR_HUNDRED_DAYS],
      ["sb-x-auth-token.1", "", 0],
    ]);
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/eyJhY2Nlc3NfdG9rZW4iOiJ2MSJ9/);
  });

  it("no session: 401 and nothing written - not even the library's removals", async () => {
    h.user = null;
    h.libraryWrites = [
      { name: "sb-x-auth-token.0", value: "", options: { path: "/", maxAge: 0 } },
    ];
    const res = await POST(keepRequest(SIGNED_IN_COOKIES));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("no cookie at all: 401, nothing written", async () => {
    const res = await POST(keepRequest(""));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("hands the library the request's cookies to read the session from", async () => {
    h.user = { id: "u1" };
    await POST(keepRequest(SIGNED_IN_COOKIES));
    expect(h.seen.map((c) => c.name)).toContain("sb-x-auth-token.0");
  });
});
