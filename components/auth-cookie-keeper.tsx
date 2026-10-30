"use client";

import { useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Hands the session cookie the page just wrote back to the server, which sends it
 * again in a Set-Cookie HEADER (app/api/auth/cookie-keep/route.ts) - 2026-10-30, hunt 11.
 *
 * WebKit (Safari, and an app added to an iPhone's home screen) caps a cookie written by
 * a script at 7 days. The browser supabase client writes the session that way on every
 * refresh, so a member whose phone sat a week between two shows was signed out at the
 * venue, two hours before stage. A header-set cookie keeps the library's 400 days.
 *
 * When it asks:
 *  • TOKEN_REFRESHED - the page has just written a new token by script: always.
 *  • USER_UPDATED - a password change re-saves the SAME token by script, so a keep already
 *    out for it may have read the cookie before that write: sent again (2026-10-30, hunt 12).
 *  • SIGNED_IN / INITIAL_SESSION - auth-js says SIGNED_IN on EVERY load and every
 *    return to the foreground (it recovers the stored session), so these ask only for a
 *    token this device has not had kept yet (a real sign-in, a refresh another tab
 *    made) or when the last keep is over KEEP_AGAIN_MS old.
 *  • never on SIGNED_OUT, which instead drops a request still out: its answer would
 *    put the cookie back after the sign-out cleared it.
 * Only a token with FRESH_MS left goes: no refresh - the page's (90 s before expiry) or
 * the route's - can land while the request is out and be overwritten by the older copy.
 * That holds only for a request that ENDS: one stalled on a venue link could answer
 * minutes later, after a refresh, and put the used token back over the new one (signed
 * out at the next refresh), while the new token waited behind it unkept. So every keep is
 * dropped after KEEP_TIMEOUT_MS, and a keep for a NEWER token drops the one still out
 * and goes itself; the same token asked twice is still one request (Argon on hunt 11).
 * Web only: mounted in app/layout.tsx, which the desktop app never renders (it keeps its
 * session in localStorage, which this cap does not touch).
 */

const KEEP_URL = "/api/auth/cookie-keep";
/** This device's last keep: the token's expiry (it names the token) and when. */
const KEPT_KEY = "cueiq:auth-cookie-kept";
const KEEP_AGAIN_MS = 12 * 60 * 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;
/** The route's whole job is sub-second; far inside FRESH_MS, so a keep never outlives it. */
const KEEP_TIMEOUT_MS = 15 * 1000;

interface Kept {
  exp: number;
  at: number;
}

function readKept(): Kept | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "null") as Partial<Kept> | null;
    return v && typeof v.exp === "number" && typeof v.at === "number" ? { exp: v.exp, at: v.at } : null;
  } catch {
    return null;
  }
}

function writeKept(exp: number): void {
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify({ exp, at: Date.now() } satisfies Kept));
  } catch {
    /* storage refused: the next load simply asks again */
  }
}

export function AuthCookieKeeper() {
  useEffect(() => {
    const supabase = createClient();
    /** The keep still out, and the token (its expiry) it carries. */
    let inFlight: { ctl: AbortController; exp: number } | null = null;

    const keep = (exp: number, rewritten = false) => {
      if (inFlight?.exp === exp && !rewritten) return; // this token is already on its way
      inFlight?.ctl.abort(); // an older token's keep: its late answer must not land
      const ctl = new AbortController();
      const mine = { ctl, exp };
      inFlight = mine;
      const timer = setTimeout(() => ctl.abort(), KEEP_TIMEOUT_MS);
      fetch(KEEP_URL, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: ctl.signal,
      })
        .then((res) => {
          if (res.ok) writeKept(exp);
        })
        .catch(() => {
          /* offline, aborted, timed out: the cookie stays as the page wrote it */
        })
        .finally(() => {
          clearTimeout(timer);
          if (inFlight === mine) inFlight = null;
        });
    };

    const fresh = (s: Session | null): s is Session & { expires_at: number } =>
      typeof s?.expires_at === "number" && s.expires_at * 1000 - Date.now() > FRESH_MS;

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        inFlight?.ctl.abort();
        inFlight = null;
        return;
      }
      if (!fresh(session)) return;
      if (event === "TOKEN_REFRESHED") {
        keep(session.expires_at);
        return;
      }
      if (event === "USER_UPDATED") {
        keep(session.expires_at, true);
        return;
      }
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        const kept = readKept();
        if (!kept || kept.exp !== session.expires_at || Date.now() - kept.at > KEEP_AGAIN_MS) {
          keep(session.expires_at);
        }
      }
    });
    return () => {
      data.subscription.unsubscribe();
      inFlight?.ctl.abort();
      inFlight = null;
    };
  }, []);

  return null;
}
