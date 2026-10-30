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

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: NextRequest) {
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
