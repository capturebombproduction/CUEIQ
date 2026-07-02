// Desktop-only Supabase client — localStorage-backed session (NOT cookies).
//
// The shared web client (lib/supabase/client.ts) uses @supabase/ssr's
// createBrowserClient, which persists the auth session in COOKIES so the Next
// server can read them. Correct on the web — but the packaged desktop app runs
// the renderer from file://, where Chromium blocks cookies. The session then
// can't be stored or attached to PostgREST requests, so every RLS-guarded read
// silently runs as anon and comes back empty ("บัญชีนี้ยังไม่ได้ผูกกับ Label").
//
// Electron has no server to share cookies with, so the desktop uses the standard
// supabase-js client with localStorage (which works under file://, and persists
// across app restarts → also fixes offline cold-boot auth). Same URL + anon key,
// same backend, same RLS — ONLY the session storage differs. A Vite alias
// (vite.config.ts) + a tsconfig path point every "@/lib/supabase/client" import
// (the reused web lib AND the desktop pages) at this file, so the whole app
// shares ONE authenticated client. Memoized → a single GoTrueClient (no "multiple
// instances" refresh races) and one realtime socket.
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function createClient(): SupabaseClient {
  if (client) return client;
  // .trim() mirrors the web client: a stray newline in the env value corrupts the
  // Realtime WebSocket apikey and breaks multi-device sync.
  client = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // We sign in with a password; there's no OAuth token in the URL, and the
        // app runs under a HashRouter (file://…#/route) — don't try to parse it.
        detectSessionInUrl: false,
        storage: window.localStorage,
      },
      global: {
        // Resolve fetch at CALL time instead of letting supabase-js capture the
        // function once at client creation. Identical behavior in production —
        // but a live window.fetch override (offline simulation in browser E2E,
        // request tracing) then actually reaches this client.
        fetch: (...args) => window.fetch(...args),
      },
    }
  );
  return client;
}
