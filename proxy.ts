import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { buildCsp, CSP_HEADER, newNonce } from "@/lib/csp";

// Next 16 renamed middleware.ts → proxy.ts (export `proxy`). It runs on the Node
// runtime (Edge is not offered for proxy) - in sin1, beside the pages it guards.
export async function proxy(request: NextRequest) {
  // A fresh nonce per request (lib/csp.ts). Set on the REQUEST before
  // updateSession, whose NextResponse.next({ request }) forwards these headers:
  // Next reads the nonce off the CSP request header for its own scripts, and the
  // root layout reads x-nonce for ours. /share and /api never come through here
  // (matcher), so they carry no policy yet.
  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    dev: process.env.NODE_ENV === "development",
  });
  request.headers.set("x-nonce", nonce);
  request.headers.set(CSP_HEADER, csp);
  const response = await updateSession(request);
  response.headers.set(CSP_HEADER, csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - static assets / images / audio (public/sounds/count/*.mp3) / fonts
     * - /api/* (route handlers do their own auth, e.g. /api/audio/presign — running
     *   the proxy here would be a wasted second getUser() network call)
     * - /share/* (public run sheet via anon RPC — no session needed)
     */
    "/((?!api|share|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|wav|ogg|m4a|aac|woff|woff2|ttf)$).*)",
  ],
};
