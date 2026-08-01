// "Will the next PostgREST request really go out as THIS user — or as anon?"
//
// supabase-js degrades silently instead of failing: SupabaseClient._getAccessToken
// falls back to the ANON key whenever getSession() hands back null, and auth-js
// caches a failed refresh for a minute — exactly the window a venue reconnect (or
// a laptop waking up at the gig) lands in. An anon request is NOT an error: RLS
// just answers it with an empty result and no error at all. So "nothing came
// back" is a lie during that window, and every verdict drawn from one costs real
// work: a cached dashboard overwritten with an empty list, an offline edit parked
// as a bogus conflict, a show reported as "ไม่พบงานนี้" while its bundle sits on
// disk — or, worst of all, a RUNNING setlist emptied out mid-show.
//
// So before believing an empty read, ask the same question _getAccessToken asks.
// Only worth asking when there is something to lose: a genuinely empty answer to a
// user who owns nothing is both cheap and correct to accept.
//
// Absolute import so the desktop build's alias swaps in its localStorage-backed
// client (a relative one would pull the web's cookie client, which can't
// authenticate under Electron's file:// origin).
import { createClient } from "@/lib/supabase/client";

export async function hasLiveSession(): Promise<boolean> {
  try {
    const { data } = await createClient().auth.getSession();
    return !!data.session?.access_token;
  } catch {
    return false;
  }
}
