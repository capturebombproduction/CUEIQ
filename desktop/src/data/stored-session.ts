// The RAW persisted Supabase session, read straight from localStorage — WITHOUT
// going through supabase-js.
//
// Why this exists (the offline cold-boot landmine): supabase-js `getSession()`
// returns `session: null` when the access token has ACTUALLY expired and the
// refresh call can't reach the server (auth-js __loadSession → _callRefreshToken:
// a retryable network failure past the token's real expiry). Access tokens live
// ~1 hour, so a desktop cold boot at a no-internet venue hours after the last
// online use would bounce to /login even though the session (refresh token +
// user identity) is still safely in storage and every page + audio file is
// cached on disk. That kills the one job this program must never fail at:
// เปิดเพลงออฟไลน์ให้ได้เสมอ.
//
// Crucially, auth-js only REMOVES the stored session on a real sign-out or a
// server-confirmed rejection (non-retryable refresh error) — never on a network
// failure. So "a stored session exists" ⇔ "this user never signed out", which
// makes it a safe identity for OFFLINE, cache-only entry: the app shows exactly
// the data this user already had on disk, and the moment the network returns the
// auto-refresh ticker mints a real session (TOKEN_REFRESHED) and the app resumes
// normal online auth seamlessly.
export interface StoredSessionUser {
  id: string;
  email: string | null;
}

export function getStoredSessionUser(): StoredSessionUser | null {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      // default supabase-js key: sb-<projectRef>-auth-token (one JSON value —
      // chunking only happens in @supabase/ssr's cookie storage, not here)
      if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      let s: {
        user?: { id?: string; email?: string | null };
        refresh_token?: string;
      } | null;
      try {
        s = JSON.parse(raw);
      } catch {
        continue; // one corrupt entry must not hide a valid one under another key
      }
      // a refresh token must be present — without one the session can never
      // come back to life online, so don't honor it offline either
      const id = s?.user?.id;
      if (typeof id === "string" && id && s?.refresh_token) {
        return { id, email: s.user?.email ?? null };
      }
    }
  } catch {
    /* unreadable/corrupt storage → treat as signed out */
  }
  return null;
}
