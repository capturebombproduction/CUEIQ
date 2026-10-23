import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed middleware.ts → proxy.ts (export `proxy`). It runs on the Node
// runtime (Edge is not offered for proxy) - in sin1, beside the pages it guards.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
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
