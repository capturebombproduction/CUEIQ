import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - static assets / images
     * - /api/* (route handlers do their own auth, e.g. /api/audio/presign — running
     *   middleware here would be a wasted second getUser() network call)
     * - /share/* (public run sheet via anon RPC — no session needed)
     */
    "/((?!api|share|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
