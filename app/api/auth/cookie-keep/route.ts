import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, DEFAULT_COOKIE_OPTIONS, type CookieOptions } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// KEEP THE SIGN-IN AS LONG AS IT SHOULD LAST (2026-10-30, hunt 11)
//
// WebKit - Safari and every app added to an iPhone's home screen - caps any cookie a
// SCRIPT writes (document.cookie) at 7 days, whatever max-age it asks for. The browser
// supabase client (lib/supabase/client.ts) writes the session cookie exactly that way on
// every token refresh, i.e. after an hour with the app open or on coming back to it, and
// the proxy only sends Set-Cookie when it refreshed the token itself. A show day ends on a
// script write, so a phone that did not open CueIQ for a week met /login at the venue.
// A cookie that arrives in a Set-Cookie HEADER is not capped: this route sends the
// session cookie back that way, unchanged, with the library's own 400-day options.
// components/auth-cookie-keeper.tsx calls it right after the page wrote a fresh token.
//
// Why a route of its own and not the proxy: /api is outside the proxy's matcher, so
// nothing else writes on this response. An echo added to the proxy would ride on every
// navigation, and a page that refreshed meanwhile (V1 sent, V2 written) would be handed
// V1 back - a refresh token that is already used, i.e. signed out.
// ---------------------------------------------------------------------------

/** The session cookie and its chunks (`.0`, `.1` …) - never `-code-verifier`. */
const SESSION_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

type SetCookie = { name: string; value: string; options: CookieOptions };

/** A token this close to its expiry is about to be refreshed by the page (90 s before). */
const NEAR_REFRESH_MS = 4 * 60 * 1000;

/** The stored session's expires_at (epoch s), or null when it cannot be read. */
function expiryOf(raw: string): number | null {
  try {
    // @supabase/ssr writes `base64-` + base64url(JSON) by default
    const text = raw.startsWith("base64-")
      ? Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8")
      : raw;
    const exp = (JSON.parse(text) as { expires_at?: unknown } | null)?.expires_at;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** The expiry of every stored session among the request's cookies - a whole cookie, or
 *  its `.0`, `.1` … chunks joined (the whole one wins, as in the library). */
function storedExpiries(cookies: { name: string; value: string }[]): (number | null)[] {
  const whole = new Map<string, string>();
  const chunks = new Map<string, Map<number, string>>();
  for (const { name, value } of cookies) {
    const m = /^(sb-.+-auth-token)(?:\.(\d+))?$/.exec(name);
    if (!m) continue;
    if (m[2] === undefined) whole.set(m[1], value);
    else {
      const parts = chunks.get(m[1]) ?? new Map<number, string>();
      parts.set(Number(m[2]), value);
      chunks.set(m[1], parts);
    }
  }
  const values = [...whole.values()];
  for (const [base, parts] of chunks) {
    if (whole.has(base)) continue;
    let joined = "";
    for (let i = 0; parts.has(i); i++) joined += parts.get(i);
    values.push(joined);
  }
  return values.map(expiryOf);
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: NextRequest) {
  // A token near its refresh is left alone - not echoed, and not even read, because
  // getUser() would refresh it here while the page refreshes it too (one refresh token,
  // two users of it). The keeper only sends tokens with 5 min left and drops a keep after
  // 15 s, so this answers only a request that stalled on the way (Argon on hunt 11).
  // An unreadable value proves nothing and goes on as before.
  const now = Date.now();
  if (storedExpiries(request.cookies.getAll()).some((e) => e != null && e * 1000 - now < NEAR_REFRESH_MS)) {
    return noStore(NextResponse.json({ kept: false }, { status: 409 }));
  }

  // What the library itself wrote while reading the user (a refresh) - that is the
  // answer then, and nothing is echoed over it.
  const lib = { wrote: null as SetCookie[] | null };
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: SetCookie[]) {
          lib.wrote = [...(lib.wrote ?? []), ...cookiesToSet];
        },
      },
    }
  );

  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    userId = null;
  }
  // Not signed in (or the auth server could not say): write NOTHING - not even the
  // library's removals. The page's own client decides about its session.
  if (!userId) return noStore(NextResponse.json({ kept: false }, { status: 401 }));

  const res = NextResponse.json({ kept: true });
  if (lib.wrote) {
    for (const { name, value, options } of lib.wrote) res.cookies.set(name, value, options);
  } else {
    for (const { name, value } of request.cookies.getAll()) {
      if (!SESSION_COOKIE.test(name)) continue;
      // the value exactly as it came, under @supabase/ssr's defaults: path "/", lax,
      // 400 days and NOT HttpOnly - the browser client must still read it
      res.cookies.set(name, value, { ...DEFAULT_COOKIE_OPTIONS });
    }
  }
  return noStore(res);
}
